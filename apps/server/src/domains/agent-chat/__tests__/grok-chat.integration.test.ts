import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

describe('AgentChatService with a fake Grok Build ACP agent', () => {
    it('streams a turn and binds the preset session on its first turn', async () => {
        const { database, service, terminal, signals, until, sessionOpens } = await fixture({
            provider: 'grok',
        });
        await until((snapshot) => snapshot.status === 'ready');
        expect(database.getTerminal(terminal.id)?.agentSessionId).toBeUndefined();
        expect(service.read(terminal.id).commands?.map((command) => command.name)).toEqual([
            'compact',
            'review',
        ]);

        await service.send(terminal.id, { text: 'hi there' });
        const snapshot = await until(
            (current) => current.turns.at(-1)?.status === 'completed' && !current.activeTurnId,
        );
        expect(snapshot.items.map((item) => item.type)).toEqual([
            'userMessage',
            'reasoning',
            'agentMessage',
        ]);
        expect(snapshot.items[1]).toMatchObject({
            text: 'Thinking about the request.',
            streaming: false,
        });
        expect(snapshot.items.at(-1)).toMatchObject({
            text: 'You said: hi there',
            streaming: false,
        });
        expect(snapshot.plan?.steps).toEqual([
            { step: 'Read the request', status: 'completed' },
            { step: 'Reply', status: 'inProgress' },
        ]);
        expect(snapshot.model).toBe('grok-fake');
        expect(snapshot.usage).toEqual({ totalTokens: 1208, contextWindow: 256000 });
        const [open] = await sessionOpens();
        expect(open.method).toBe('session/new');
        expect(open.args).toEqual(['agent', '--no-leader', 'stdio']);
        expect(database.getTerminal(terminal.id)?.agentSessionId).toMatch(/^[\da-f-]{36}$/u);
        expect(signals.map((signal) => signal.phase)).toEqual([
            'sessionIdentified',
            'turnStarted',
            'turnFinished',
        ]);
    });

    it('carries the autonomy flag and structured options to the agent', async () => {
        const { service, terminal, until, sessionOpens } = await fixture({
            provider: 'grok',
            launchArgs: ['--yolo', '--model', 'grok-x', '--sandbox workspace', '--no-alt-screen'],
        });
        await until((snapshot) => snapshot.status === 'ready');
        expect(service.read(terminal.id).status).toBe('ready');
        const [open] = await sessionOpens();
        expect(open.args).toEqual([
            '--sandbox',
            'workspace',
            'agent',
            '--always-approve',
            '--model',
            'grok-x',
            '--no-leader',
            'stdio',
        ]);
    });

    it('asks before a command and runs it once accepted', async () => {
        const { service, terminal, signals, until } = await fixture({ provider: 'grok' });
        await service.send(terminal.id, { text: 'please approve this' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        const request = pending.requests[0];
        expect(request).toMatchObject({
            kind: 'command',
            command: 'npm test',
            reason: 'Run npm test',
            decisions: ['accept', 'acceptForSession', 'decline'],
        });
        expect(pending.items.find((item) => item.id === request.id)).toMatchObject({
            type: 'command',
            status: 'running',
            output: '',
        });
        service.respond(terminal.id, request.id, { kind: 'decision', decision: 'accept' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.requests).toEqual([]);
        expect(done.items.find((item) => item.id === request.id)).toMatchObject({
            type: 'command',
            command: 'npm test',
            status: 'completed',
            output: 'npm test: ok',
        });
        expect(done.items.at(-1)).toMatchObject({ type: 'agentMessage', text: 'The command ran.' });
        expect(signals.map((signal) => signal.phase)).toContain('attentionResolved');
    });

    it('records a declined command as declined', async () => {
        const { service, terminal, until } = await fixture({ provider: 'grok' });
        await service.send(terminal.id, { text: 'please approve this' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        const request = pending.requests[0];
        service.respond(terminal.id, request.id, { kind: 'decision', decision: 'decline' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.find((item) => item.id === request.id)).toMatchObject({
            type: 'command',
            status: 'declined',
        });
        expect(done.items.at(-1)).toMatchObject({ text: 'The command was declined.' });
    });

    it('answers a pending approval cancelled when the turn is interrupted', async () => {
        const { service, terminal, signals, until } = await fixture({ provider: 'grok' });
        await service.send(terminal.id, { text: 'please approve this' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        const request = pending.requests[0];
        await service.interrupt(terminal.id);
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'interrupted');
        expect(done.status).toBe('ready');
        expect(done.requests).toEqual([]);
        expect(done.items.find((item) => item.id === request.id)).toMatchObject({
            type: 'command',
            status: 'declined',
        });
        expect(signals.map((signal) => signal.phase)).toContain('attentionResolved');
        await service.send(terminal.id, { text: 'still alive' });
        const next = await until(
            (snapshot) => snapshot.turns.length === 2 && !snapshot.activeTurnId,
        );
        expect(next.items.at(-1)).toMatchObject({ text: 'You said: still alive' });
    });

    it('survives a second Stop for the same turn', async () => {
        const { service, terminal, until } = await fixture({ provider: 'grok' });
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) =>
            snapshot.items.some((item) => item.type === 'agentMessage' && item.text.length > 0),
        );
        await Promise.all([service.interrupt(terminal.id), service.interrupt(terminal.id)]);
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'interrupted');
        expect(done.status).toBe('ready');
    });

    it('gates a file edit and shows the diff Grok Build reports', async () => {
        const { service, terminal, until } = await fixture({ provider: 'grok' });
        await service.send(terminal.id, { text: 'patch it' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        const request = pending.requests[0];
        expect(request).toMatchObject({ kind: 'fileChange', decisions: ['accept', 'decline'] });
        service.respond(terminal.id, request.id, { kind: 'decision', decision: 'accept' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        const change = done.items.find((item) => item.id === request.id);
        expect(change).toMatchObject({ type: 'fileChange', status: 'completed' });
        expect(change?.type === 'fileChange' && change.changes).toEqual([
            {
                path: expect.stringMatching(/src\/app\.ts$/u) as string,
                kind: 'update',
                diff: '@@\n-const value = 1;\n+const value = 2;',
            },
        ]);
    });

    it('interrupts a running turn', async () => {
        const { service, terminal, until } = await fixture({ provider: 'grok' });
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) =>
            snapshot.items.some((item) => item.type === 'agentMessage' && item.text.length > 0),
        );
        await service.interrupt(terminal.id);
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'interrupted');
        expect(done.activeTurnId).toBeUndefined();
        expect(done.status).toBe('ready');
        expect(done.items.at(-1)).toMatchObject({ type: 'agentMessage', streaming: false });
    });

    it('steers a message sent mid-turn into the running turn', async () => {
        const { service, terminal, until } = await fixture({ provider: 'grok' });
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) =>
            snapshot.items.some((item) => item.type === 'agentMessage' && item.text.length > 0),
        );
        await service.send(terminal.id, { text: 'and then' }, 'steer');
        const heard = await until((snapshot) =>
            snapshot.items.some(
                (item) => item.type === 'agentMessage' && item.text.includes('Heard: and then'),
            ),
        );
        expect(heard.turns).toHaveLength(1);
        expect(
            heard.items.filter((item) => item.type === 'userMessage').map((item) => item.text),
        ).toEqual(['slow please', 'and then']);
        expect(heard.items.findLast((item) => item.type === 'userMessage')).toMatchObject({
            delivery: 'steered',
        });
        await service.interrupt(terminal.id);
    });

    it('rejects images, which Grok Build Chat does not accept', async () => {
        const { service, terminal, until } = await fixture({ provider: 'grok' });
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

    it('reports a failed turn with its error', async () => {
        const { service, terminal, signals, until } = await fixture({ provider: 'grok' });
        await service.send(terminal.id, { text: 'fail please' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'failed');
        expect(done.items.at(-1)).toMatchObject({
            type: 'notice',
            kind: 'error',
            message: 'The model request failed',
        });
        expect(signals.at(-1)).toMatchObject({ phase: 'turnFailed' });
    });

    it('runs compact as a command turn and marks the compaction', async () => {
        const { service, terminal, signals, until } = await fixture({ provider: 'grok' });
        await until((snapshot) => snapshot.status === 'ready');
        await service.runCommand(terminal.id, 'compact');
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items[0]).toMatchObject({ type: 'userMessage', text: '/compact' });
        expect(done.items.at(-1)).toMatchObject({ type: 'notice', kind: 'compacted' });
        expect(signals.map((signal) => signal.phase)).toContain('compactionFinished');
    });

    it('resumes the bound session with the history session/load replays', async () => {
        const { service, terminal, until, sessionOpens } = await fixture({ provider: 'grok' });
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
        expect(resumed.items[0]).toMatchObject({ text: 'remember me' });
        expect(resumed.items.at(-1)).toMatchObject({
            text: 'You said: remember me',
            streaming: false,
        });
        expect(resumed.turns).toEqual([
            expect.objectContaining({
                status: 'completed',
                durationMs: expect.any(Number) as number,
            }),
        ]);
        expect((await sessionOpens()).map((open) => open.method)).toEqual([
            'session/new',
            'session/load',
        ]);
        await service.send(terminal.id, { text: 'still here' });
        const next = await until(
            (snapshot) => snapshot.turns.length === 2 && !snapshot.activeTurnId,
        );
        expect(next.items.at(-1)).toMatchObject({ text: 'You said: still here' });
    });

    it('fails visibly instead of starting a new session when the conversation is gone', async () => {
        const { database, service, terminal } = await fixture({ provider: 'grok' });
        database.rebindAgentSession(terminal.id, 'grok', crypto.randomUUID());
        await service.restart(terminal.id);
        const snapshot = service.read(terminal.id);
        expect(snapshot.status).toBe('failed');
        expect(snapshot.failure?.reason).toBe('resume_failed');
    });

    it('marks a crash mid-turn as an interrupted turn and a dead process', async () => {
        const { database, service, terminal, until } = await fixture({ provider: 'grok' });
        await service.send(terminal.id, { text: 'crash now' });
        const snapshot = await until((current) => current.status === 'failed');
        expect(snapshot.failure?.reason).toBe('process_exited');
        expect(snapshot.turns.at(-1)?.status).toBe('interrupted');
        expect(database.getTerminal(terminal.id)?.lastProcessState).toBe('dead');
    });
});
