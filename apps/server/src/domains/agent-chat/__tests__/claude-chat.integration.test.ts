import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

describe('AgentChatService with a fake Claude Code CLI', () => {
    it('streams a turn and binds the preset session on its first turn', async () => {
        const { database, service, terminal, signals, until } = await fixture({
            provider: 'claude',
        });
        await until((snapshot) => snapshot.status === 'ready');
        expect(database.getTerminal(terminal.id)?.agentSessionId).toBeUndefined();

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
            type: 'agentMessage',
            text: 'Hello from fake Claude. You said: hi there',
            streaming: false,
        });
        expect(snapshot.items[1]).toMatchObject({
            text: 'Considering the request.',
            streaming: false,
        });
        expect(snapshot.plan?.steps).toEqual([
            { step: 'Read the message', status: 'completed' },
            { step: 'Reply', status: 'inProgress' },
        ]);
        expect(snapshot.model).toBe('fake-claude-model');
        expect(snapshot.usage).toEqual({ totalTokens: 2040, contextWindow: 200000 });
        expect(service.read(terminal.id)).toEqual(snapshot);
        expect(database.getTerminal(terminal.id)?.agentSessionId).toMatch(/^[\da-f-]{36}$/u);
        expect(signals.map((signal) => signal.phase)).toEqual([
            'sessionIdentified',
            'turnStarted',
            'turnFinished',
        ]);
    });

    it('asks before a command and runs it once accepted', async () => {
        const { service, terminal, signals, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'please approve this' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        const request = pending.requests[0];
        expect(request).toMatchObject({
            kind: 'command',
            command: 'echo approved',
            reason: 'Fake Bash approval',
            decisions: ['accept', 'acceptForSession', 'decline'],
        });
        service.respond(terminal.id, request.id, { kind: 'decision', decision: 'accept' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.find((item) => item.type === 'command')).toMatchObject({
            id: request.id,
            status: 'completed',
            output: 'approved',
        });
        expect(done.items.at(-1)).toMatchObject({ text: 'The command ran.' });
        expect(signals.map((signal) => signal.phase)).toContain('attentionResolved');
    });

    it('records a declined command as declined', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'please approve this' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        service.respond(terminal.id, pending.requests[0].id, {
            kind: 'decision',
            decision: 'decline',
        });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.find((item) => item.type === 'command')).toMatchObject({
            status: 'declined',
        });
        expect(done.items.at(-1)).toMatchObject({ text: 'Skipped the command.' });
    });

    it('gates a file edit and shows the patch Claude Code reports', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'edit the notes' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        const request = pending.requests[0];
        expect(request).toMatchObject({ kind: 'fileChange', itemId: request.id });
        service.respond(terminal.id, request.id, { kind: 'decision', decision: 'accept' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.find((item) => item.type === 'fileChange')).toMatchObject({
            status: 'completed',
            changes: [{ kind: 'update', diff: '@@ -3,1 +3,1 @@\n-old line\n+new line' }],
        });
    });

    it('asks to approve a plan as a generic tool request', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'planmode' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        const request = pending.requests[0];
        expect(request).toMatchObject({
            kind: 'tool',
            name: 'ExitPlanMode',
            summary: '1. Read the notes.\n2. Summarize them in one paragraph.',
        });
        service.respond(terminal.id, request.id, { kind: 'decision', decision: 'accept' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.at(-1)).toMatchObject({ text: 'Plan approved.' });
    });

    it('answers an AskUserQuestion question by its question text', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'ask me' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        const request = pending.requests[0];
        expect(request).toMatchObject({
            kind: 'question',
            questions: [{ id: 'q0', header: 'Color', question: 'Which color?' }],
        });
        service.respond(terminal.id, request.id, { kind: 'answers', answers: { q0: ['Blue'] } });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.at(-1)).toMatchObject({ text: 'You chose Blue.' });
        expect(done.items.at(-2)).toMatchObject({ type: 'notice', message: 'Color: Blue' });
        // The question card is the request; it never also shows as a tool row.
        expect(done.items.some((item) => item.type === 'toolCall')).toBe(false);
    });

    it('interrupts a running turn', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) =>
            snapshot.items.some((item) => item.type === 'agentMessage' && item.text.length > 0),
        );
        await service.interrupt(terminal.id);
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'interrupted');
        expect(done.activeTurnId).toBeUndefined();
        expect(done.items.at(-1)).toMatchObject({ type: 'agentMessage', streaming: false });
    });

    it('reports a failed turn with its error', async () => {
        const { service, terminal, signals, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'fail please' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'failed');
        expect(done.items.at(-1)).toMatchObject({
            type: 'notice',
            kind: 'error',
            message: 'The fake model is overloaded.',
        });
        expect(signals.at(-1)).toMatchObject({ phase: 'turnFailed' });
    });

    it('resumes the bound session with history read from its transcript', async () => {
        const { service, terminal, spawnProcess, until } = await fixture({ provider: 'claude' });
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
        expect(resumed.items.at(-1)).toMatchObject({
            text: 'Hello from fake Claude. You said: remember me',
        });
        expect(resumed.turns).toEqual([
            expect.objectContaining({
                status: 'completed',
                durationMs: expect.any(Number) as number,
            }),
        ]);
        expect(
            spawnProcess.mock.calls[1][1].some((argument) => argument.startsWith('--resume')),
        ).toBe(true);
        await service.send(terminal.id, { text: 'still here' });
        const next = await until(
            (snapshot) => snapshot.turns.length === 2 && !snapshot.activeTurnId,
        );
        expect(next.items.at(-1)).toMatchObject({
            text: 'Hello from fake Claude. You said: still here',
        });
    });

    it('fails visibly instead of starting a new session when the transcript is gone', async () => {
        const { database, service, terminal, spawnProcess } = await fixture({ provider: 'claude' });
        database.rebindAgentSession(terminal.id, 'claude', crypto.randomUUID());
        await service.restart(terminal.id);
        const snapshot = service.read(terminal.id);
        expect(snapshot.status).toBe('failed');
        expect(snapshot.failure?.reason).toBe('resume_failed');
        expect(spawnProcess).not.toHaveBeenCalled();
    });

    it('marks a crash mid-turn as a failed turn and a dead process', async () => {
        const { database, service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'crash now' });
        const snapshot = await until((current) => current.status === 'failed');
        expect(snapshot.failure?.reason).toBe('process_exited');
        expect(snapshot.turns.at(-1)?.status).toBe('interrupted');
        expect(database.getTerminal(terminal.id)?.lastProcessState).toBe('dead');
    });

    it('opens a turn when Claude Code continues on its own after a background task', async () => {
        const { service, terminal, until, signals } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'start a background job' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');

        const working = await until((snapshot) =>
            snapshot.items.some((item) => item.type === 'command' && item.status === 'running'),
        );
        expect(working.turns).toHaveLength(2);
        expect(working.activeTurnId).toBe(working.turns[1]?.id);
        expect(working.items.at(-1)).toMatchObject({ turnId: working.activeTurnId });

        const done = await until(
            (snapshot) => !snapshot.activeTurnId && snapshot.turns[1]?.status === 'completed',
        );
        expect(done.items.filter((item) => item.type === 'userMessage')).toHaveLength(1);
        expect(signals.filter((signal) => signal.phase === 'turnStarted')).toHaveLength(2);
    });

    it('folds a message sent mid-turn into the running turn', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'pause first' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await service.send(terminal.id, { text: 'and then' });
        const done = await until(
            (snapshot) =>
                !snapshot.activeTurnId &&
                snapshot.items.at(-1)?.type === 'agentMessage' &&
                snapshot.items.some(
                    (item) => item.type === 'agentMessage' && item.text.includes('and then'),
                ),
        );
        expect(done.turns).toHaveLength(1);
        expect(done.items.filter((item) => item.type === 'userMessage')).toHaveLength(2);
    });
});
