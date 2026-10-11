import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { fixture } from './chat-service-fixture';

describe('AgentChatService with a fake Codex app-server', () => {
    it('streams a turn into a projection every Client converges on, and binds the thread on its first turn', async () => {
        const { database, service, terminal, signals, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        expect(database.getTerminal(terminal.id)?.agentSessionId).toBeUndefined();
        expect(database.getTerminal(terminal.id)?.lastProcessState).toBe('running');

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
            text: 'Hello from fake Codex. You said: hi there',
            streaming: false,
        });
        // Every summary part, the first included, is announced; only later parts start a paragraph.
        expect(snapshot.items[1]).toMatchObject({
            type: 'reasoning',
            text: 'Thinking about it.\n\nChecking the reply.',
        });
        expect(snapshot.plan?.steps).toHaveLength(2);
        expect(snapshot.usage).toEqual({
            totalTokens: 1200,
            contextWindow: 200000,
            breakdown: [
                { label: 'Cached input', tokens: 900 },
                { label: 'New input', tokens: 250 },
                { label: 'Output', tokens: 50 },
            ],
            cacheTtlMinutes: 30,
            lastResponseAt: snapshot.usage?.lastResponseAt,
        });
        expect(snapshot.usage?.lastResponseAt).toBeGreaterThan(0);
        // The server's own snapshot equals the patched Client mirror.
        expect(service.read(terminal.id)).toEqual(snapshot);
        expect(database.getTerminal(terminal.id)?.agentSessionId).toBeTruthy();
        expect(signals.map((signal) => signal.phase)).toEqual([
            'sessionIdentified',
            'turnStarted',
            'turnFinished',
        ]);
    });

    it('answers an approval by its stable request id and clears attention', async () => {
        const { service, terminal, signals, until } = await fixture();
        await service.send(terminal.id, { text: 'please approve this' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        const request = pending.requests[0];
        expect(request).toMatchObject({ kind: 'command', command: 'echo approved' });
        service.respond(terminal.id, request.id, { kind: 'decision', decision: 'accept' });
        expect(() =>
            service.respond(terminal.id, request.id, { kind: 'decision', decision: 'accept' }),
        ).toThrow(/no longer pending/u);
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.requests).toEqual([]);
        expect(done.items.find((item) => item.type === 'command')).toMatchObject({
            status: 'completed',
            output: 'approved\n',
            exitCode: 0,
        });
        expect(signals.map((signal) => signal.phase)).toContain('attentionRequested');
        expect(signals.map((signal) => signal.phase)).toContain('attentionResolved');
    });

    it('links a file-change approval to the change it gates and marks an oversized diff', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'make a patch' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        const request = pending.requests[0];
        if (request.kind !== 'fileChange') throw new Error('expected a file-change approval');
        // The card reads its diff preview from this item, so it must already hold every change.
        const gated = pending.items.find((item) => item.id === request.itemId);
        expect(gated).toMatchObject({ type: 'fileChange', status: 'running' });
        if (gated?.type !== 'fileChange') throw new Error('expected a file-change item');
        expect(gated.changes.map((change) => change.kind)).toEqual(['update', 'add', 'delete']);
        expect(gated.changes.every((change) => change.truncated === undefined)).toBe(true);
        service.respond(terminal.id, request.id, { kind: 'decision', decision: 'accept' });
        const applied = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(applied.items.find((item) => item.id === request.itemId)).toMatchObject({
            status: 'completed',
        });

        await service.send(terminal.id, { text: 'write a bigdiff' });
        const done = await until(
            (snapshot) => snapshot.turns.length === 2 && snapshot.turns[1].status === 'completed',
        );
        const large = done.items.findLast((item) => item.type === 'fileChange');
        expect(large).toMatchObject({ changes: [{ truncated: true }] });
    });

    it('answers a question with the chosen option', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'ask me' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        const request = pending.requests[0];
        expect(request.kind).toBe('question');
        expect(() =>
            service.respond(terminal.id, request.id, { kind: 'decision', decision: 'accept' }),
        ).toThrow(/needs answers/u);
        service.respond(terminal.id, request.id, { kind: 'answers', answers: { color: ['Blue'] } });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.at(-1)).toMatchObject({ text: 'You chose Blue.' });
        // The card is gone, so the timeline keeps the chosen answer before the reply that acts on it.
        expect(done.items.at(-2)).toMatchObject({
            type: 'notice',
            kind: 'answered',
            message: 'Color: Blue',
        });
    });

    it('skips a question so the turn continues without an answer', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'ask me' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        service.respond(terminal.id, pending.requests[0].id, {
            kind: 'decision',
            decision: 'cancel',
        });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.requests).toEqual([]);
        expect(done.items.at(-1)).toMatchObject({ text: 'You chose nothing.' });
        expect(done.items.some((item) => item.type === 'notice')).toBe(false);
    });

    it('interrupts a running turn and closes its dangling stream', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) =>
            snapshot.items.some((item) => item.type === 'agentMessage' && item.text.length > 0),
        );
        expect(service.hasActiveTurn(terminal.id)).toBe(true);
        await service.interrupt(terminal.id);
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'interrupted');
        expect(done.activeTurnId).toBeUndefined();
        expect(service.hasActiveTurn(terminal.id)).toBe(false);
        expect(done.items.at(-1)).toMatchObject({ type: 'agentMessage', streaming: false });
    });

    it('resumes the bound thread with its history after the process stops', async () => {
        const { service, terminal, spawnProcess, until } = await fixture();
        await service.send(terminal.id, { text: 'remember me' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        await service.restart(terminal.id);
        const resumed = service.read(terminal.id);
        expect(resumed.status).toBe('ready');
        expect(resumed.items.find((item) => item.type === 'userMessage')).toMatchObject({
            text: 'remember me',
        });
        expect(spawnProcess).toHaveBeenCalledTimes(2);
    });

    it('shows the original times of a resumed conversation', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'remember me' });
        const live = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        const liveReply = live.items.findLast((item) => item.type === 'agentMessage');
        await service.restart(terminal.id);

        // Codex records turn starts in seconds and item starts in milliseconds.
        const resumed = await until((snapshot) =>
            snapshot.items.some(
                (item) => item.type === 'agentMessage' && item.createdAt !== undefined,
            ),
        );
        const user = resumed.items.find((item) => item.type === 'userMessage');
        const reply = resumed.items.findLast((item) => item.type === 'agentMessage');
        expect(user?.createdAt).toBeGreaterThan(Date.now() - 60_000);
        expect(user?.createdAt).toBeLessThanOrEqual(liveReply?.createdAt ?? 0);
        expect(reply?.createdAt).toBeGreaterThanOrEqual(user?.createdAt ?? Infinity);
        expect(reply?.createdAt).toBeLessThanOrEqual(Date.now());
    });

    it('keeps the replaced start in YOLO on a resume restart after Settings turned it off', async () => {
        let launchArguments = ['--dangerously-bypass-approvals-and-sandbox'];
        const { service, terminal, threadOpens, until } = await fixture({
            launchArgs: () => launchArguments,
        });
        await service.send(terminal.id, { text: 'remember me' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');

        launchArguments = [];
        await service.restart(terminal.id, true);
        await service.restart(terminal.id);

        expect(await threadOpens()).toEqual([
            { method: 'thread/start', sandbox: 'danger-full-access', approvalPolicy: 'never' },
            { method: 'thread/resume', sandbox: 'danger-full-access', approvalPolicy: 'never' },
            { method: 'thread/resume', sandbox: 'workspace-write', approvalPolicy: 'on-request' },
        ]);
    });

    it('keeps a Client that cached the old projection converging after a restart', async () => {
        const { service, terminal, client, until } = await fixture();
        await service.send(terminal.id, { text: 'before restart' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        const cachedRevision = client().revision;
        await service.restart(terminal.id);
        await service.send(terminal.id, { text: 'after restart' });
        const snapshot = await until((current) =>
            current.items.some(
                (item) =>
                    item.type === 'agentMessage' &&
                    item.text === 'Hello from fake Codex. You said: after restart',
            ),
        );
        expect(snapshot.revision).toBeGreaterThan(cachedRevision);
        expect(snapshot).toEqual(service.read(terminal.id));
    });

    it('ends the turn and its pending attention when a restart stops the process mid-request', async () => {
        const { service, terminal, signals, until } = await fixture();
        await service.send(terminal.id, { text: 'please approve this' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        await service.restart(terminal.id);
        const phases = signals.map((signal) => signal.phase);
        expect(phases.slice(phases.lastIndexOf('attentionRequested'))).toEqual([
            'attentionRequested',
            'attentionResolved',
            'turnFinished',
        ]);
        expect(signals.find((signal) => signal.phase === 'attentionResolved')).toMatchObject({
            agentToolUseId: pending.requests[0].id,
        });
        expect(signals.at(-1)).toMatchObject({ agentTurnId: pending.activeTurnId });
    });

    it('fails visibly instead of starting a new thread when a bound conversation cannot be resumed', async () => {
        const { database, service, terminal } = await fixture();
        database.rebindAgentSession(terminal.id, 'codex', 'missing-thread');
        await service.restart(terminal.id);
        const snapshot = service.read(terminal.id);
        expect(snapshot.status).toBe('failed');
        expect(snapshot.failure?.reason).toBe('resume_failed');
        expect(database.getTerminal(terminal.id)).toMatchObject({
            agentSessionId: 'missing-thread',
            lastProcessState: 'failed',
            failureReason: 'agent_session_unavailable',
        });
    });

    it('reports a conversation another Codex client still holds instead of a lost one', async () => {
        const { database, service, terminal, holdCodexThreadWriter } = await fixture();
        database.rebindAgentSession(terminal.id, 'codex', 'thread-held-elsewhere');
        await holdCodexThreadWriter('thread-held-elsewhere');
        await service.restart(terminal.id);
        const snapshot = service.read(terminal.id);
        expect(snapshot.status).toBe('failed');
        expect(snapshot.failure?.reason).toBe('conversation_in_use');
        expect(database.getTerminal(terminal.id)).toMatchObject({
            agentSessionId: 'thread-held-elsewhere',
            lastProcessState: 'failed',
            failureReason: 'agent_session_unavailable',
        });
    });

    it('marks a crash mid-turn as a failed turn and a dead process', async () => {
        const { database, service, terminal, signals, until } = await fixture();
        await service.send(terminal.id, { text: 'crash now' });
        const snapshot = await until((current) => current.status === 'failed');
        expect(snapshot.failure?.reason).toBe('process_exited');
        expect(snapshot.turns.at(-1)?.status).toBe('interrupted');
        expect(database.getTerminal(terminal.id)?.lastProcessState).toBe('dead');
        expect(signals.at(-1)).toMatchObject({
            phase: 'turnFailed',
            agentFailure: 'provider_failed',
        });
    });

    it('starts one process for concurrent reads and sends', async () => {
        const { service, terminal, spawnProcess, until } = await fixture();
        service.read(terminal.id);
        service.read(terminal.id);
        await Promise.all([
            service.send(terminal.id, { text: 'one' }),
            service.send(terminal.id, { text: 'two' }),
        ]);
        await until((snapshot) => snapshot.turns.length > 0 && !snapshot.activeTurnId);
        expect(spawnProcess).toHaveBeenCalledTimes(1);
    });

    it('queues a message sent after the process spawned but before its thread is ready', async () => {
        const { service, terminal, spawnProcess, until } = await fixture();
        service.read(terminal.id);
        await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1), { interval: 1 });
        expect(service.read(terminal.id).status).toBe('starting');
        await service.send(terminal.id, { text: 'early bird' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.at(-1)).toMatchObject({
            text: 'Hello from fake Codex. You said: early bird',
        });
        expect(spawnProcess).toHaveBeenCalledTimes(1);
    });

    it('rejects a PTY Terminal', async () => {
        const { database, service, terminal } = await fixture();
        const pty = database.createTerminal(terminal.sessionId, 'codex', terminal.cwd);
        expect(() => service.read(pty.id)).toThrow(/does not use Chat/u);
    });

    it('counts live provider processes per Session', async () => {
        const { database, service, terminal, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        const other = database.createSession(
            database.getSession(terminal.sessionId)!.projectId,
            null,
        );
        expect(service.liveCount(terminal.sessionId)).toBe(1);
        expect(service.liveCount(other.session.id)).toBe(0);
        await service.shutdown();
    });

    it('stops every provider process on shutdown', async () => {
        const { service, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        expect(service.liveCount()).toBe(1);
        await service.shutdown();
        expect(service.liveCount()).toBe(0);
    });
});

describe('AgentChatService under a real-Agent E2E policy', () => {
    function stubRealPolicy(surface: 'chat' | 'pty') {
        vi.stubEnv('CAXRI_E2E', '1');
        vi.stubEnv('CAXRI_E2E_AGENT_MODE', 'real');
        vi.stubEnv('CAXRI_E2E_AGENT_PROVIDER', 'codex');
        vi.stubEnv('CAXRI_E2E_AGENT_SURFACE', surface);
        onTestFinished(() => {
            vi.unstubAllEnvs();
        });
    }

    it('opens a read-only, approval-free thread that ignores the user launch settings', async () => {
        stubRealPolicy('chat');
        const { service, terminal, spawnProcess, until, threadOpens } = await fixture({
            launchArgs: ['--dangerously-bypass-approvals-and-sandbox', '-c', 'model="other"'],
        });
        await until((snapshot) => snapshot.status === 'ready');
        expect(spawnProcess.mock.calls[0][1]).toEqual(['app-server', '--listen', 'stdio://']);
        expect(await threadOpens()).toEqual([
            { method: 'thread/start', sandbox: 'read-only', approvalPolicy: 'never' },
        ]);
        await expect(service.send(terminal.id, { text: 'x'.repeat(201) })).rejects.toThrow(
            /short natural prompts/u,
        );
        await service.send(terminal.id, { text: 'What is this project about?' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
    });

    it('refuses to start a Chat for the real PTY smoke', async () => {
        stubRealPolicy('pty');
        const { spawnProcess, until } = await fixture();
        const failed = await until((snapshot) => snapshot.status === 'failed');
        expect(failed.failure).toMatchObject({ reason: 'spawn_failed' });
        expect(spawnProcess).not.toHaveBeenCalled();
    });
});
