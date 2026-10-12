import { glob, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { inheritChatPermission } from '../../session/creation';
import type { CreateForkSession } from '../chat-fork';
import { forkClaudeSession } from '../claude-rewind';
import { fixture } from './chat-service-fixture';

type Provider = 'claude' | 'codex' | 'grok';

function userTexts(snapshot: AgentChatSnapshot): string[] {
    return snapshot.items.flatMap((item) => (item.type === 'userMessage' ? [item.text] : []));
}

function isSettled(snapshot: AgentChatSnapshot, turns: number): boolean {
    return (
        snapshot.turns.length === turns &&
        !snapshot.activeTurnId &&
        snapshot.turns.every((turn) => turn.status === 'completed')
    );
}

/**
 * Starts a Chat with three completed turns, `first`, `second`, and `third`, and a session creator that opens a fork the
 * way `session.create` does: a new Session's Chat Terminal with the source's stored permission, bound to the forked
 * Agent Session before it starts.
 */
async function threeTurns(provider: Provider) {
    const context = await fixture({ provider });
    for (const [index, text] of ['first', 'second', 'third'].entries()) {
        // eslint-disable-next-line no-await-in-loop -- each turn must finish before the next is sent
        await context.service.send(context.terminal.id, { text });
        // eslint-disable-next-line no-await-in-loop -- see above
        await context.until((snapshot) => isSettled(snapshot, index + 1));
    }
    const messageId = (text: string): string => {
        const item = context
            .client()
            .items.find((candidate) => candidate.type === 'userMessage' && candidate.text === text);
        if (!item) throw new Error(`The ${text} message is missing`);
        return item.id;
    };
    const createSession = vi.fn<CreateForkSession>(
        ({ projectId, provider: kind, cwd, agentSessionId, sourceTerminalId }) => {
            const { session } = context.database.createSession(projectId, null);
            const terminal = context.database.createTerminal(session.id, kind, cwd, 'chat');
            inheritChatPermission(context.database, sourceTerminalId, terminal.id);
            if (agentSessionId)
                context.database.rebindAgentSession(terminal.id, kind, agentSessionId);
            return Promise.resolve({ sessionId: session.id, terminalId: terminal.id });
        },
    );
    return { ...context, messageId, createSession };
}

/**
 * The one session transcript the fake Claude CLI wrote under `configDirectory`.
 */
async function claudeTranscriptPath(configDirectory: string): Promise<string> {
    const paths = await Array.fromAsync(glob('projects/*/*.jsonl', { cwd: configDirectory }));
    expect(paths).toHaveLength(1);
    return join(configDirectory, paths[0]);
}

describe('AgentChatService fork', () => {
    it.each<Provider>(['claude', 'codex', 'grok'])(
        'forks a %s conversation before an earlier message into a new Chat',
        async (provider) => {
            const { service, terminal, messageId, createSession } = await threeTurns(provider);
            const forked = await service.fork(terminal.id, messageId('second'), createSession);

            expect(createSession).toHaveBeenCalledOnce();
            const [opened] = createSession.mock.calls[0];
            expect(opened.provider).toBe(provider);
            expect(opened.agentSessionId).toBeTypeOf('string');
            await service.restart(forked.terminalId);
            expect(userTexts(service.read(forked.terminalId))).toEqual(['first']);
            // The source Chat keeps every turn.
            expect(userTexts(service.read(terminal.id))).toEqual(['first', 'second', 'third']);
        },
    );

    it('opens an empty Chat when the first message is forked, without asking the provider', async () => {
        const { service, terminal, messageId, createSession, fakeLog } = await threeTurns('codex');
        await service.fork(terminal.id, messageId('first'), createSession);
        expect(createSession).toHaveBeenCalledWith(
            expect.objectContaining({ agentSessionId: undefined }),
        );
        expect(await fakeLog('codex', 'thread-forks.jsonl')).toEqual([]);
    });

    it("inherits the source Chat's stored permission level and plan mode", async () => {
        const { service, terminal, database, messageId, createSession } = await threeTurns('codex');
        await service.setPermission(terminal.id, { permissionMode: 'readOnly', planMode: true });
        // A broader Project default must not override the narrower level the user picked.
        const { projectId } = database.getSession(terminal.sessionId)!;
        database.setProjectChatDefault(projectId, 'codex', { permissionMode: 'auto' });
        const forked = await service.fork(terminal.id, messageId('second'), createSession);
        expect(createSession).toHaveBeenCalledWith(
            expect.objectContaining({ sourceTerminalId: terminal.id }),
        );
        expect(database.getChatPermission(forked.terminalId)).toEqual({
            permissionMode: 'readOnly',
            planMode: true,
        });
    });

    it('keeps the Project default when the source Chat stored no permission choice', async () => {
        const { service, terminal, database, messageId, createSession } = await threeTurns('codex');
        const { projectId } = database.getSession(terminal.sessionId)!;
        database.setProjectChatDefault(projectId, 'codex', {
            permissionMode: 'readOnly',
            planMode: true,
        });
        const forked = await service.fork(terminal.id, messageId('second'), createSession);
        expect(database.getChatPermission(forked.terminalId)).toEqual({
            permissionMode: 'readOnly',
            planMode: true,
        });
    });

    it('forks a Claude conversation whose transcript has malformed lines, skipping them', async () => {
        const context = await threeTurns('claude');
        const { service, terminal, messageId, createSession, logWrite } = context;
        const transcriptPath = await claudeTranscriptPath(context.claudeConfigDirectory);
        const lines = (await readFile(transcriptPath, 'utf8')).trimEnd().split('\n');
        // A corrupt record in the middle, and a trailing line cut short by an interrupted write.
        lines.splice(1, 0, '{"type":"user","message":');
        await writeFile(transcriptPath, `${lines.join('\n')}\n{"type":"assistant","uuid":"cut`);

        const forked = await service.fork(terminal.id, messageId('second'), createSession);

        const logged = logWrite.mock.calls.find(([, event]) => event === 'agent_chat.forked');
        expect(logged?.[2]?.fields).toMatchObject({ outcome: 'forked', skippedRecords: 2 });
        await service.restart(forked.terminalId);
        expect(userTexts(service.read(forked.terminalId))).toEqual(['first']);
    });

    it('refuses to fork a Claude transcript above the size limit', async () => {
        const context = await threeTurns('claude');
        const { terminal, messageId } = context;
        const transcriptPath = await claudeTranscriptPath(context.claudeConfigDirectory);
        const content = await readFile(transcriptPath, 'utf8');
        const agentSessionId = context.database.getTerminal(terminal.id)!.agentSessionId!;
        await expect(
            forkClaudeSession(
                agentSessionId,
                {
                    cwd: terminal.cwd,
                    environment: { CLAUDE_CONFIG_DIR: context.claudeConfigDirectory },
                },
                { content, truncated: false },
                {
                    itemId: messageId('second'),
                    turnId: '',
                    text: 'second',
                    keptTurns: 1,
                    removedTurns: 2,
                },
                // The real limit is 256 MiB; a small one stands in so the test writes no such file.
                16,
            ),
        ).rejects.toMatchObject({
            code: 'CAPACITY',
            message: expect.stringContaining('too large to fork') as string,
        });
    });

    it('refuses while a turn is running and creates nothing', async () => {
        const { service, terminal, until, messageId, createSession, logWrite } =
            await threeTurns('codex');
        await service.send(terminal.id, { text: 'slow' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await expect(
            service.fork(terminal.id, messageId('second'), createSession),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(createSession).not.toHaveBeenCalled();
        const forked = logWrite.mock.calls.find(([, event]) => event === 'agent_chat.forked');
        expect(forked?.[2]?.fields).toMatchObject({ outcome: 'refused', code: 'CONFLICT' });
    });
});
