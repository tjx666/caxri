import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';

import { resolveServerExecutable } from '../apps/server/src/domains/executables.ts';
import { realCodexSmokeArguments } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import type { RunningCaxri } from './support/helpers.ts';
import {
    chooseDefaultTerminal,
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    openAddProjectDialog,
    pageRequest,
    waitForCreatedSession,
} from './support/helpers.ts';

const isRealAgentEnabled = process.env.CAXRI_REAL_AGENT_E2E === '1';
const expectedReply = 'CAXRI_REAL_AGENT_OK';
const prompt = `Read README.md and reply exactly ${expectedReply}. Do not modify any files.`;
/**
 * Ordinary, read-only questions a user would ask about a fresh Project. The Chat smoke never asserts on, logs, or
 * captures the replies; only content-free protocol signals are checked.
 */
const chatPrompts = [
    'What is this project about? Please answer in one short sentence.',
    'Thanks. Which file did you look at?',
] as const;

test.use({ screenshot: 'off', trace: 'off' });
test.skip(
    !isRealAgentEnabled,
    'Set CAXRI_REAL_AGENT_E2E=1 to authorize the isolated real Codex smoke test.',
);

/**
 * Fails with an explicit reason instead of falling back when Codex is missing or signed out.
 */
async function assertAuthenticatedCodex(): Promise<void> {
    const executable = await resolveServerExecutable('codex');
    if (!executable) throw new Error('Real Agent E2E requires the Codex CLI on the login PATH');
    try {
        await execFileAsync(executable, ['login', 'status'], { timeout: 10_000 });
    } catch {
        throw new Error('Real Agent E2E requires an authenticated Codex CLI');
    }
}

async function createSmokeProject(): Promise<{
    directory: string;
    userData: string;
    root: string;
}> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-real-agent-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'README.md'), '# Real Agent smoke fixture\n', 'utf8');
    return { directory, userData, root };
}

test('an explicitly authorized real Codex handles one natural read-only prompt', async () => {
    test.setTimeout(90_000);
    if (/\p{Cc}/u.test(prompt) || prompt.length > 200)
        throw new Error(
            'Real Agent smoke prompts must be short natural text without control bytes',
        );
    await assertAuthenticatedCodex();

    const { directory, userData, root } = await createSmokeProject();
    const running = await launchCaxri({
        agentMode: { mode: 'real', provider: 'codex' },
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify({
                'agents.providers': {
                    codex: {
                        hooks: { enabled: false },
                        launch: {
                            executable: 'codex',
                            args: realCodexSmokeArguments(prompt),
                        },
                    },
                },
            }),
        });
        await createProjectSession(running.page, 'codex');
        await expect(running.page.locator('.xterm-rows')).toContainText(expectedReply, {
            timeout: 60_000,
        });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * Content-free view of a Chat projection. Every assertion and failure message reads only this shape, so a failed run
 * can never print the model's reply.
 */
interface ChatSignals {
    status: AgentChatSnapshot['status'];
    failure?: string;
    turns: string[];
    activeTurn: boolean;
    userMessages: number;
    agentMessages: number;
    requests: number;
    /**
     * Whether the real provider's model name and token usage parsed into the projection.
     */
    hasModel: boolean;
    hasUsage: boolean;
}

async function readChatSignals(running: RunningCaxri, terminalId: string): Promise<ChatSignals> {
    const snapshot = await pageRequest<AgentChatSnapshot>(running.page, 'agentChat.read', {
        terminalId,
    });
    return {
        status: snapshot.status,
        ...(snapshot.failure && { failure: snapshot.failure.reason }),
        turns: snapshot.turns.map((turn) => turn.status),
        activeTurn: snapshot.activeTurnId !== undefined,
        userMessages: snapshot.items.filter((item) => item.type === 'userMessage').length,
        agentMessages: snapshot.items.filter((item) => item.type === 'agentMessage').length,
        requests: snapshot.requests.length,
        hasModel: snapshot.model !== undefined,
        hasUsage: snapshot.usage !== undefined,
    };
}

interface ChatTerminal {
    id: string;
    surface?: string;
    agentSessionId?: string;
}

async function readChatTerminal(running: RunningCaxri): Promise<ChatTerminal> {
    const state = await pageRequest<{ terminals: ChatTerminal[] }>(running.page, 'app.bootstrap');
    // Compare surfaces only: Terminal titles may be derived from conversation content.
    expect(
        state.terminals.map((terminal) => terminal.surface ?? 'pty'),
        'exactly one Chat Terminal and no PTY Terminal',
    ).toEqual(['chat']);
    return state.terminals[0];
}

/**
 * Sends one prompt and waits for its turn to finish, asserting only statuses and item counts.
 */
async function sendChatTurn(
    running: RunningCaxri,
    terminalId: string,
    text: string,
    finishedTurns: number,
): Promise<ChatSignals> {
    await pageRequest(running.page, 'agentChat.send', { terminalId, text });
    let signals: ChatSignals | undefined;
    await expect
        .poll(
            async () => {
                signals = await readChatSignals(running, terminalId);
                return signals.turns.length >= finishedTurns && !signals.activeTurn
                    ? signals.turns.at(-1)
                    : signals.status;
            },
            { timeout: 120_000, intervals: [1_000] },
        )
        .toBe('completed');
    return signals!;
}

/**
 * Agent Chat events from the Server Core log, reduced to closed enums. Durations and identifiers are dropped.
 */
async function readChatEvents(userData: string): Promise<string[]> {
    const source = await readFile(join(userData, 'logs', 'server-core.jsonl'), 'utf8');
    return source
        .trim()
        .split('\n')
        .flatMap((line) => {
            const record = JSON.parse(line) as {
                event?: string;
                fields?: Record<string, unknown>;
            };
            if (!record.event?.startsWith('agent_chat.')) return [];
            const fields = record.fields ?? {};
            const detail = ['outcome', 'mode', 'reason', 'status', 'requested']
                .filter((key) => fields[key] !== undefined && fields[key] !== null)
                .map((key) => `${key}=${String(fields[key])}`)
                .join(',');
            return [`${record.event}(${detail})`];
        });
}

/**
 * PIDs of `codex app-server` processes whose working directory is the smoke Project. The Project is unique to this run,
 * so a developer's own Codex sessions are never counted or touched.
 */
async function projectAppServerPids(root: string): Promise<string[]> {
    let candidates: string[];
    try {
        const { stdout } = await execFileAsync('pgrep', ['-f', 'app-server --listen stdio://']);
        candidates = stdout.trim().split('\n').filter(Boolean);
    } catch {
        return [];
    }
    const owned = await Promise.all(
        candidates.map(async (pid) => {
            try {
                const { stdout } = await execFileAsync('lsof', [
                    '-a',
                    '-p',
                    pid,
                    '-d',
                    'cwd',
                    '-Fn',
                ]);
                return stdout.split('\n').includes(`n${root}`) ? [pid] : [];
            } catch {
                return [];
            }
        }),
    );
    return owned.flat();
}

test('an explicitly authorized real Codex Chat streams a reply and resumes its conversation', async () => {
    test.setTimeout(900_000);
    for (const text of chatPrompts)
        if (/\p{Cc}/u.test(text) || text.length > 200)
            throw new Error('Real Chat smoke prompts must be short natural text');
    await assertAuthenticatedCodex();

    const { directory, userData, root } = await createSmokeProject();
    const launch = () =>
        launchCaxri({
            agentMode: { mode: 'real', provider: 'codex', surface: 'chat' },
            userDataDir: userData,
            testRootPath: root,
            /**
             * The relaunch releases and re-acquires the shared desktop lease. Waiting for a sibling instead of failing
             * keeps a busy runner from discarding a first turn that already reached the real model.
             */
            desktopLeaseWaitMs: 240_000,
        });
    let running = await launch();
    try {
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify({ 'session.openAgentsInChat': true }),
        });
        const previous = await pageRequest<{ selectedSessionId?: string }>(
            running.page,
            'app.bootstrap',
        );
        await openAddProjectDialog(running.page);
        await chooseDefaultTerminal(running.page, 'Codex Chat');
        await waitForCreatedSession(running.page, previous.selectedSessionId);
        const created = await readChatTerminal(running);

        const first = await sendChatTurn(running, created.id, chatPrompts[0], 1);
        expect(first).toMatchObject({
            status: 'ready',
            userMessages: 1,
            requests: 0,
            hasModel: true,
            hasUsage: true,
        });
        expect(first.agentMessages).toBeGreaterThan(0);
        const bound = await readChatTerminal(running);
        expect(bound.agentSessionId, 'the first turn binds the Codex thread').toBeTruthy();

        await running.app.close();
        await expect.poll(() => projectAppServerPids(root)).toEqual([]);

        // A relaunch must reopen the same thread with its history rather than start a new one.
        running = await launch();
        let resumed: ChatSignals | undefined;
        await expect
            .poll(async () => {
                resumed = await readChatSignals(running, created.id);
                return resumed.status;
            })
            .toBe('ready');
        expect(resumed!.userMessages, 'resumed history').toBe(1);
        expect(resumed!.agentMessages).toBeGreaterThan(0);
        const second = await sendChatTurn(running, created.id, chatPrompts[1], 2);
        expect(second).toMatchObject({ status: 'ready', userMessages: 2, requests: 0 });
        expect((await readChatTerminal(running)).agentSessionId, 'same Codex thread').toBe(
            bound.agentSessionId,
        );

        await running.app.close();
        await expect.poll(() => projectAppServerPids(root)).toEqual([]);

        const events = await readChatEvents(userData);
        test.info().annotations.push({
            type: 'agent-chat-events',
            description: events.join(' → '),
        });
        console.log(`Real Codex Chat events: ${events.join(' → ')}`);
        expect(events.filter((event) => event.startsWith('agent_chat.process_started'))).toEqual([
            'agent_chat.process_started(outcome=ready,mode=started)',
            'agent_chat.process_started(outcome=ready,mode=resumed)',
        ]);
        expect(events.filter((event) => event.startsWith('agent_chat.turn_finished'))).toEqual([
            'agent_chat.turn_finished(status=completed)',
            'agent_chat.turn_finished(status=completed)',
        ]);
        expect(events.some((event) => event.startsWith('agent_chat.protocol_rejected'))).toBe(
            false,
        );
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
