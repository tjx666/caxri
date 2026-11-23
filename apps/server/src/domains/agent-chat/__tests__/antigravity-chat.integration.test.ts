import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AntigravityUsageAnswer } from '../../agents/providers/antigravity/usage-command';
import { fixture } from './chat-service-fixture';

/**
 * The `agy -p /usage` reading a used-up turn asks for. It answers unknown, as a fixture with no real CLI does, unless a
 * test holds it to answer later.
 */
const usageReading = vi.hoisted(() => ({
    held: undefined as PromiseWithResolvers<AntigravityUsageAnswer> | undefined,
}));

vi.mock('../../agents/providers/antigravity/usage-command', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    readAntigravityUsage: () =>
        usageReading.held?.promise ?? Promise.resolve({ status: 'unknown' as const }),
}));

/**
 * What `agy --version` answers when a handshake failed; unknown unless a test sets it.
 */
const installedVersion = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock('../../agents/discovery', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    readVersion: () => Promise.resolve(installedVersion.value),
}));

afterEach(() => {
    usageReading.held = undefined;
    installedVersion.value = undefined;
    vi.unstubAllEnvs();
});

const RESETS_AT = Date.now() + 3_600_000;

/**
 * A reading with Gemini's 5-hour window used up.
 */
const USED_UP: AntigravityUsageAnswer = {
    status: 'signedIn',
    limit: {
        observedAt: Date.now(),
        windows: [
            {
                windowMinutes: 300,
                usedPercent: 100,
                resetsAt: RESETS_AT,
                scope: 'session',
                group: 'Gemini',
            },
        ],
    },
};

describe('AgentChatService with a fake Antigravity ACP agent', () => {
    it('streams a turn and binds the session id the agent chose on its first turn', async () => {
        const { database, service, terminal, signals, until, sessionOpens } = await fixture({
            provider: 'antigravity',
        });
        const ready = await until((snapshot) => snapshot.status === 'ready');
        expect(database.getTerminal(terminal.id)?.agentSessionId).toBeUndefined();
        expect(ready).toMatchObject({ model: 'gemini-fake-flash', effort: 'high' });

        await service.send(terminal.id, { text: 'hi there' });
        const snapshot = await until(
            (current) => current.turns.at(-1)?.status === 'completed' && !current.activeTurnId,
        );
        expect(snapshot.items.map((item) => item.type)).toEqual([
            'userMessage',
            'reasoning',
            'agentMessage',
        ]);
        expect(snapshot.items.at(-1)).toMatchObject({
            text: 'You said: hi there (gemini-fake-flash, high)',
            streaming: false,
        });
        const { lastResponseAt, ...usage } = snapshot.usage ?? {};
        // The context comes from agy's `usage_update`, with its window.
        expect(usage).toEqual({
            totalTokens: 850,
            contextWindow: 1_000_000,
            cacheTtlMinutes: 60,
        });
        expect(lastResponseAt).toBeTypeOf('number');
        // Antigravity picks the id in `session/new`; a conversation without a turn is never bound.
        expect(database.getTerminal(terminal.id)?.agentSessionId).toMatch(/^[\da-f-]{36}$/u);
        const [open] = await sessionOpens();
        // Without a chosen level the Chat edits without asking; only full access passes the skip flag.
        expect(open).toEqual({ method: 'session/new', args: ['acp'] });
        expect(snapshot.permissionMode).toBe('acceptEdits');
        expect(signals.map((signal) => signal.phase)).toEqual([
            'sessionIdentified',
            'turnStarted',
            'turnFinished',
        ]);
    });

    it('carries full access and the workspace options it accepts to the agent', async () => {
        const { service, terminal, until, sessionOpens } = await fixture({
            provider: 'antigravity',
            launchArgs: ['--dangerously-skip-permissions', '--sandbox', '--add-dir', '/tmp/extra'],
        });
        await until((snapshot) => snapshot.status === 'ready');
        expect(service.read(terminal.id).permissionMode).toBe('fullAccess');
        const [open] = await sessionOpens();
        expect(open.args).toEqual([
            'acp',
            '--dangerously-skip-permissions',
            '--sandbox',
            '--add-dir',
            '/tmp/extra',
        ]);
    });

    it('asks before a command and runs it once accepted', async () => {
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        await service.send(terminal.id, { text: 'please approve this' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        const request = pending.requests[0];
        expect(request).toMatchObject({
            kind: 'command',
            command: 'npm test',
            decisions: ['accept', 'acceptForSession', 'decline'],
        });
        service.respond(terminal.id, request.id, { kind: 'decision', decision: 'accept' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.find((item) => item.id === request.id)).toMatchObject({
            type: 'command',
            command: 'npm test',
            status: 'completed',
            output: 'npm test: ok',
        });
    });

    it('records a declined command as declined although agy leaves it in progress', async () => {
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        await service.send(terminal.id, { text: 'please approve this' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        const request = pending.requests[0];
        service.respond(terminal.id, request.id, { kind: 'decision', decision: 'decline' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.find((item) => item.id === request.id)).toMatchObject({
            type: 'command',
            status: 'declined',
        });
        expect(done.items.at(-1)).toMatchObject({ text: 'The command did not run.' });
    });

    it('names a file tool the way every Chat surface presents it', async () => {
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        await service.send(terminal.id, { text: 'read the readme' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.find((item) => item.type === 'toolCall')).toMatchObject({
            name: 'Read',
            summary: expect.stringMatching(/README\.md$/u) as string,
            status: 'completed',
        });
    });

    it('switches the model and thinking level through config options', async () => {
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        const ready = await until((snapshot) => snapshot.status === 'ready');
        expect(ready.models?.map((model) => [model.id, model.efforts])).toEqual([
            ['gemini-fake-flash', ['low', 'medium', 'high']],
            ['gemini-fake-pro', ['low', 'medium', 'high']],
        ]);
        await service.configure(terminal.id, { model: 'gemini-fake-pro', effort: 'low' });
        expect(service.read(terminal.id)).toMatchObject({
            model: 'gemini-fake-pro',
            effort: 'low',
        });
        await service.send(terminal.id, { text: 'which model' });
        const done = await until(
            (snapshot) => snapshot.turns.at(-1)?.status === 'completed' && !snapshot.activeTurnId,
        );
        expect(done.items.at(-1)).toMatchObject({
            text: 'You said: which model (gemini-fake-pro, low)',
        });
    });

    it('starts a Chat with no choice of its own on the global default, which agy acp ignores', async () => {
        const resolve = vi.fn(() =>
            Promise.resolve({ model: 'gemini-fake-pro', effort: 'medium' }),
        );
        const { service, terminal, until } = await fixture({
            provider: 'antigravity',
            defaults: { observeModels: () => {}, resolve },
        });
        const ready = await until(
            (snapshot) => snapshot.status === 'ready' && snapshot.model === 'gemini-fake-pro',
        );
        expect(ready).toMatchObject({ effort: 'medium' });
        expect(ready).not.toHaveProperty('customChoice');
        expect(resolve).toHaveBeenCalledWith('antigravity');

        // A choice of the Chat's own wins over the default on the next start.
        await service.configure(terminal.id, { model: 'gemini-fake-flash' });
        await service.restart(terminal.id);
        expect(
            await until(
                (snapshot) => snapshot.status === 'ready' && snapshot.customChoice === true,
            ),
        ).toMatchObject({ model: 'gemini-fake-flash', effort: 'medium' });
    });

    it('interrupts a running turn', async () => {
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) =>
            snapshot.items.some((item) => item.type === 'agentMessage' && item.text.length > 0),
        );
        await service.interrupt(terminal.id);
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'interrupted');
        expect(done.activeTurnId).toBeUndefined();
        expect(done.status).toBe('ready');
    });

    it('keeps a turn running until the foreground command agy moved to the background finishes', async () => {
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        await service.send(terminal.id, { text: 'run the build in the background' });
        const replied = await until((snapshot) =>
            snapshot.items.some((item) => item.type === 'agentMessage' && item.text.length > 0),
        );
        const command = replied.items.find((item) => item.type === 'command')!;
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.find((item) => item.id === command.id)).toMatchObject({
            status: 'completed',
            output: 'built',
        });
        expect(done.activeTurnId).toBeUndefined();
    });

    it('ends a turn whose only running command agy started as a daemon', async () => {
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        await service.send(terminal.id, { text: 'run the build in the background as a daemon' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.activeTurnId).toBeUndefined();
    });

    it('stops a turn held for a running command', async () => {
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        await service.send(terminal.id, { text: 'run the build in the background forever' });
        await until((snapshot) =>
            snapshot.items.some(
                (item) => item.type === 'agentMessage' && item.text === 'Started the build.',
            ),
        );
        await service.interrupt(terminal.id);
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'interrupted');
        expect(done.activeTurnId).toBeUndefined();
        expect(done.status).toBe('ready');
    });

    it('stops a turn whose prompt answers after the Stop and leaves its command running', async () => {
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        await service.send(terminal.id, { text: 'run the build in the background forever, late' });
        await until((snapshot) =>
            snapshot.items.some(
                (item) => item.type === 'agentMessage' && item.text === 'Started the build.',
            ),
        );
        const stopped = Date.now();
        // The prompt has not answered yet, so no turn is held when Stop arrives.
        await service.interrupt(terminal.id);
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'interrupted');
        // Not the 10 s fallback that stops the agent process.
        expect(Date.now() - stopped).toBeLessThan(5_000);
        expect(done.status).toBe('ready');
    });

    it('stops a turn at once when the cancelled prompt leaves its command running', async () => {
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        await service.send(terminal.id, { text: 'run something stuck' });
        await until((snapshot) => snapshot.items.some((item) => item.type === 'command'));
        const stopped = Date.now();
        await service.interrupt(terminal.id);
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'interrupted');
        // Not the 10 s fallback that stops the agent process.
        expect(Date.now() - stopped).toBeLessThan(5_000);
        expect(done.status).toBe('ready');
    });

    it('steers a running turn with a new prompt, which ends the earlier one without ending the turn', async () => {
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await service.send(terminal.id, { text: 'and then' }, 'steer');
        const done = await until(
            (snapshot) => snapshot.turns.at(-1)?.status === 'completed' && !snapshot.activeTurnId,
        );
        expect(done.turns).toHaveLength(1);
        expect(done.queue ?? []).toEqual([]);
        expect(done.items.filter((item) => item.type === 'userMessage')).toMatchObject([
            { text: 'slow please' },
            { text: 'and then', delivery: 'steered' },
        ]);
        expect(done.items.at(-1)).toMatchObject({
            text: expect.stringContaining('You said: and then') as string,
        });
    });

    it('sends images as prompt content and shows their thumbnails', async () => {
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        await until((snapshot) => snapshot.status === 'ready');
        await service.send(terminal.id, {
            text: 'look',
            images: [
                {
                    mediaType: 'image/png',
                    data: 'iVBORw0KGgo=',
                    thumbnail: 'data:image/jpeg;base64,AA==',
                },
            ],
        });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items[0]).toMatchObject({
            type: 'userMessage',
            images: [{ thumbnail: 'data:image/jpeg;base64,AA==' }],
        });
        expect(done.items.at(-1)).toMatchObject({ text: 'Saw 1 image' });
    });

    it('switches the permission level and plan mode in place through session modes', async () => {
        const { service, terminal, until, sessionOpens } = await fixture({
            provider: 'antigravity',
        });
        await until((snapshot) => snapshot.status === 'ready');
        await service.setPermission(terminal.id, { permissionMode: 'auto' });
        await service.send(terminal.id, { text: 'which session mode' });
        let done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.at(-1)).toMatchObject({ text: 'Mode: auto' });
        expect(done.permissionMode).toBe('auto');

        await service.setPermission(terminal.id, { planMode: true });
        await service.send(terminal.id, { text: 'make a plan' });
        done = await until(
            (snapshot) =>
                snapshot.turns.length === 2 && snapshot.turns.at(-1)?.status === 'completed',
        );
        expect(done.planMode).toBe(true);
        const plan = done.items.find((item) => item.type === 'agentMessage' && item.proposedPlan);
        expect(plan).toMatchObject({ text: '# Plan\n\n1. Do it' });
        // No restart: both switches ran on the process that opened the conversation.
        expect((await sessionOpens()).map((open) => open.method)).toEqual(['session/new']);
    });

    it('restarts to cross full access, a launch flag', async () => {
        const { service, terminal, until, sessionOpens } = await fixture({
            provider: 'antigravity',
        });
        await until((snapshot) => snapshot.status === 'ready');
        await service.setPermission(terminal.id, { permissionMode: 'fullAccess' });
        await until((snapshot) => snapshot.status === 'ready');
        expect(service.read(terminal.id).permissionMode).toBe('fullAccess');
        const opens = await sessionOpens();
        expect(opens.at(-1)?.args).toEqual(['acp', '--dangerously-skip-permissions']);
    });

    it('fails a turn refused on a used-up quota with the limit it hit', async () => {
        const { service, terminal, until, signals } = await fixture({ provider: 'antigravity' });
        await service.send(terminal.id, { text: 'use the quota' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'failed');
        expect(done.items.at(-1)).toMatchObject({
            type: 'notice',
            kind: 'error',
            // The test spawns no real `agy -p /usage`, so the window that ran out is unknown here; reading it is
            // `antigravityUsageLimit`'s unit test.
            usageLimit: { window: 'unknown' },
        });
        expect(signals.at(-1)).toMatchObject({
            phase: 'turnFailed',
            agentFailure: 'billing_error',
        });
    });

    it('ends a used-up turn before its quota reading answers, then names the window that ran out', async () => {
        usageReading.held = Promise.withResolvers();
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        await service.send(terminal.id, { text: 'use the quota' });
        const failed = await until((snapshot) => snapshot.turns.at(-1)?.status === 'failed');
        // The reading is still held, so the turn ended without waiting on it.
        expect(failed.items.at(-1)).toMatchObject({ usageLimit: { window: 'unknown' } });

        usageReading.held.resolve(USED_UP);
        const refined = await until((snapshot) => {
            const notice = snapshot.items.at(-1);
            return notice?.type === 'notice' && notice.usageLimit?.window === 'session';
        });
        expect(refined.items.at(-1)).toMatchObject({
            type: 'notice',
            kind: 'error',
            message: expect.stringContaining('quota') as string,
            usageLimit: { window: 'session', resetsAt: RESETS_AT },
        });
    });

    it('leaves a used-up notice unknown when the Chat moved on before its reading answered', async () => {
        usageReading.held = Promise.withResolvers();
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        await service.send(terminal.id, { text: 'use the quota' });
        const failed = await until((snapshot) => snapshot.turns.at(-1)?.status === 'failed');
        const turnId = failed.turns.at(-1)!.id;
        await service.send(terminal.id, { text: 'hello again' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');

        usageReading.held.resolve(USED_UP);
        await usageReading.held.promise;
        await new Promise((resolve) => setTimeout(resolve, 50));
        const notice = service
            .read(terminal.id)
            .items.find((item) => item.id === `${turnId}:error`);
        expect(notice).toMatchObject({ usageLimit: { window: 'unknown' } });
    });

    it('resumes the bound session with the history session/load replays', async () => {
        const { service, terminal, until, sessionOpens } = await fixture({
            provider: 'antigravity',
        });
        await service.send(terminal.id, { text: 'remember me' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        await service.restart(terminal.id);
        const resumed = service.read(terminal.id);
        expect(resumed.status).toBe('ready');
        expect(resumed.items.map((item) => item.type)).toEqual([
            'userMessage',
            'reasoning',
            'agentMessage',
        ]);
        // agy replays no turn ends, so a replayed turn reads as completed rather than cut off.
        expect(resumed.turns.map((turn) => turn.status)).toEqual(['completed']);
        expect((await sessionOpens()).map((open) => open.method)).toEqual([
            'session/new',
            'session/load',
        ]);
    });

    it('fails visibly instead of starting a new session when the conversation is gone', async () => {
        const { database, service, terminal } = await fixture({ provider: 'antigravity' });
        database.rebindAgentSession(terminal.id, 'antigravity', crypto.randomUUID());
        await service.restart(terminal.id);
        const snapshot = service.read(terminal.id);
        expect(snapshot.status).toBe('failed');
        expect(snapshot.failure?.reason).toBe('resume_failed');
    });

    it('asks for an update when an agy older than 1.5.0 has no ACP server', async () => {
        vi.stubEnv('FAKE_ANTIGRAVITY_VERSION', '1.4.11');
        installedVersion.value = 'agy 1.4.11';
        const { until } = await fixture({ provider: 'antigravity' });
        await expect(until((snapshot) => snapshot.status === 'failed')).resolves.toMatchObject({
            failure: { reason: 'unsupported_version' },
        });
    });

    it('keeps the handshake failure of an agy recent enough for Chat', async () => {
        vi.stubEnv('FAKE_ANTIGRAVITY_VERSION', '1.4.11');
        installedVersion.value = 'agy 1.5.14';
        const { until } = await fixture({ provider: 'antigravity' });
        await expect(until((snapshot) => snapshot.status === 'failed')).resolves.toMatchObject({
            failure: { reason: 'handshake_failed' },
        });
    });

    it('asks for an update when the ACP server reports a version older than 1.5.0', async () => {
        vi.stubEnv('FAKE_ANTIGRAVITY_VERSION', '0.9.0');
        const { until } = await fixture({ provider: 'antigravity' });
        await expect(until((snapshot) => snapshot.status === 'failed')).resolves.toMatchObject({
            failure: { reason: 'unsupported_version' },
        });
    });
});
