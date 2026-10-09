import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AgentChatSnapshot, ServerEvent } from '@caxri/protocol';
import { applyAgentChatPatch, defaultAgentProviderSettings } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentLifecycleSignal } from '../../agents';
import { CaxriDatabase } from '../../db';
import { AgentChatService } from '../service';

const FAKE_APP_SERVER = join(import.meta.dirname, 'fixtures', 'fake-codex-app-server.ts');

async function fixture(options: { launchArgs?: string[] } = {}) {
    const directory = await realpath(await mkdtemp(`${tmpdir()}/caxri-agent-chat-`));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const projectRoot = join(directory, 'project');
    const stateDirectory = join(directory, 'codex');
    await mkdir(projectRoot);
    const project = database.createProject(projectRoot);
    const { session } = database.createSession(project.id, null);
    const terminal = database.createTerminal(session.id, 'codex', projectRoot, 'chat');
    const events: ServerEvent[] = [];
    const signals: AgentLifecycleSignal[] = [];
    const coordinator = {
        beginTerminalLaunch: vi.fn(),
        endTerminalLaunch: vi.fn(),
        probeTerminal: vi.fn(),
    };
    const logger = { write: vi.fn() } as unknown as StructuredLogger;
    const spawnProcess = vi.fn(
        (_executable: string, arguments_: string[], spawnOptions: SpawnOptionsWithoutStdio) =>
            spawn(process.execPath, [FAKE_APP_SERVER, ...arguments_], spawnOptions),
    );
    const service = new AgentChatService({
        database,
        logger,
        send: (event) => events.push(event),
        environment: () =>
            Promise.resolve({ ...process.env, FAKE_CODEX_STATE_DIR: stateDirectory }),
        launchSettings: () => ({
            ...defaultAgentProviderSettings.codex.launch,
            args: options.launchArgs ?? [],
        }),
        resolveExecutable: () => Promise.resolve('/fake/codex'),
        coordinator,
        observeLifecycleSignal: (signal) => {
            signals.push(signal);
            return Promise.resolve('accepted');
        },
        clientVersion: '0.0.0-test',
        spawnProcess,
    });
    onTestFinished(async () => {
        await service.shutdown();
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    /**
     * Mirrors a Client: one read, then every patch applied with the shared reducer, re-reading on a revision gap.
     */
    let mirror: AgentChatSnapshot | undefined;
    function client(): AgentChatSnapshot {
        mirror ??= service.read(terminal.id);
        const pending = [...events];
        events.length = 0;
        for (const event of pending) {
            if (event.event !== 'agentChat.patch') continue;
            const patch = event.payload;
            if (patch.revision <= mirror.revision) continue;
            mirror = applyAgentChatPatch(mirror, patch) ?? service.read(terminal.id);
        }
        return mirror;
    }
    async function until(isReached: (snapshot: AgentChatSnapshot) => boolean) {
        await vi.waitFor(
            () => {
                expect(isReached(client())).toBe(true);
            },
            { timeout: 5_000, interval: 10 },
        );
        return client();
    }
    return { database, service, terminal, signals, coordinator, spawnProcess, client, until };
}

describe('AgentChatService with a fake Codex app-server', () => {
    it('streams a turn into a projection every Client converges on, and binds the thread on its first turn', async () => {
        const { database, service, terminal, signals, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        expect(database.getTerminal(terminal.id)?.agentSessionId).toBeUndefined();
        expect(database.getTerminal(terminal.id)?.lastProcessState).toBe('running');

        await service.send(terminal.id, 'hi there');
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
        expect(snapshot.plan?.steps).toHaveLength(2);
        expect(snapshot.usage).toEqual({ totalTokens: 1200, contextWindow: 200000 });
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
        await service.send(terminal.id, 'please approve this');
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

    it('answers a question with the chosen option', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, 'ask me');
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
        await service.send(terminal.id, 'ask me');
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
        await service.send(terminal.id, 'slow please');
        await until((snapshot) =>
            snapshot.items.some((item) => item.type === 'agentMessage' && item.text.length > 0),
        );
        await service.interrupt(terminal.id);
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'interrupted');
        expect(done.activeTurnId).toBeUndefined();
        expect(done.items.at(-1)).toMatchObject({ type: 'agentMessage', streaming: false });
    });

    it('resumes the bound thread with its history after the process stops', async () => {
        const { service, terminal, spawnProcess, until } = await fixture();
        await service.send(terminal.id, 'remember me');
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        await service.restart(terminal.id);
        const resumed = service.read(terminal.id);
        expect(resumed.status).toBe('ready');
        expect(resumed.items.find((item) => item.type === 'userMessage')).toMatchObject({
            text: 'remember me',
        });
        expect(spawnProcess).toHaveBeenCalledTimes(2);
    });

    it('keeps a Client that cached the old projection converging after a restart', async () => {
        const { service, terminal, client, until } = await fixture();
        await service.send(terminal.id, 'before restart');
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        const cachedRevision = client().revision;
        await service.restart(terminal.id);
        await service.send(terminal.id, 'after restart');
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
        await service.send(terminal.id, 'please approve this');
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

    it('marks a crash mid-turn as a failed turn and a dead process', async () => {
        const { database, service, terminal, signals, until } = await fixture();
        await service.send(terminal.id, 'crash now');
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
        await Promise.all([service.send(terminal.id, 'one'), service.send(terminal.id, 'two')]);
        await until((snapshot) => snapshot.turns.length > 0 && !snapshot.activeTurnId);
        expect(spawnProcess).toHaveBeenCalledTimes(1);
    });

    it('queues a message sent after the process spawned but before its thread is ready', async () => {
        const { service, terminal, spawnProcess, until } = await fixture();
        service.read(terminal.id);
        await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1), { interval: 1 });
        expect(service.read(terminal.id).status).toBe('starting');
        await service.send(terminal.id, 'early bird');
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
