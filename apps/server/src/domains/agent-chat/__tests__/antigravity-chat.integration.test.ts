import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

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
        expect(usage).toEqual({ totalTokens: 900, cacheTtlMinutes: 60 });
        expect(lastResponseAt).toBeTypeOf('number');
        // Antigravity picks the id in `session/new`; a conversation without a turn is never bound.
        expect(database.getTerminal(terminal.id)?.agentSessionId).toMatch(/^[\da-f-]{36}$/u);
        const [open] = await sessionOpens();
        // Ask-before-commands is agy's default; only full access passes the skip flag.
        expect(open).toEqual({ method: 'session/new', args: ['acp'] });
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

    it('queues a mid-turn message behind the turn, since agy cannot steer', async () => {
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await service.send(terminal.id, { text: 'and then' }, 'steer');
        const queued = await until((snapshot) => (snapshot.queue?.length ?? 0) > 0);
        expect(queued.queue?.map((entry) => entry.text)).toEqual(['and then']);
        expect(queued.turns).toHaveLength(1);
        await service.interrupt(terminal.id);
    });

    it('rejects images, which agy acp does not accept', async () => {
        const { service, terminal, until } = await fixture({ provider: 'antigravity' });
        await until((snapshot) => snapshot.status === 'ready');
        await expect(
            service.send(terminal.id, {
                text: 'look',
                images: [
                    {
                        mediaType: 'image/png',
                        data: 'iVBORw0KGgo=',
                        thumbnail: 'data:image/jpeg;base64,AA==',
                    },
                ],
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
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
});
