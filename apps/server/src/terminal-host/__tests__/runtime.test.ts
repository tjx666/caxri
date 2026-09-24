import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalRecord } from '@caxri/protocol';
import type { ObservationContext } from '@caxri/system';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionStart } from '../engine/engine';
import type { TerminalHostMessage, TerminalHostRequestEnvelope } from '../protocol';
import { TERMINAL_HOST_PROTOCOL_VERSION, terminalHostRequestEnvelopeSchema } from '../protocol';
import type { ManagedAgentExecutionOwner, TerminalExecutionOwner } from '../runtime';
import { TerminalHostRuntime } from '../runtime';

const credential = 'a'.repeat(64);
const bootId = 'b'.repeat(32);
const terminal: TerminalRecord = {
    id: 'terminal-1',
    sessionId: 'session-1',
    cwd: '/project',
    kind: 'shell',
    title: 'Shell',
    icon: 'terminal',
    orderIndex: 0,
    lastProcessState: 'starting',
    createdAt: 1,
    updatedAt: 1,
};
const temporaryDirectories: string[] = [];
const loggers: StructuredLogger[] = [];

function privateRequest(
    request: TerminalHostRequestEnvelope['request'],
    scope: TerminalHostRequestEnvelope['scope'],
    id: string,
    observation?: ObservationContext,
): TerminalHostRequestEnvelope {
    return terminalHostRequestEnvelopeSchema.parse({
        type: 'request',
        protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
        id,
        ...(observation && { observation }),
        bootId,
        credential,
        scope,
        request,
    });
}

function fakeEngine() {
    const attach = vi.fn(() => Promise.resolve({ snapshot: null, wasAttached: false }));
    const snapshot = vi.fn(() => Promise.resolve(null));
    const start = vi.fn<(input: TerminalExecutionStart) => number>(() => 42);
    const write = vi.fn(() => true);
    return {
        attach,
        snapshot,
        start,
        write,
        owner: {
            attach,
            close: vi.fn(),
            detachAllViews: vi.fn(),
            detachView: vi.fn(),
            observe: vi.fn(() =>
                Promise.resolve({
                    snapshot: {
                        terminalId: terminal.id,
                        encodingVersion: 1,
                        cols: 80,
                        rows: 24,
                        lineCount: 0,
                        byteCount: 0,
                        payload: '',
                        updatedAt: 1,
                    },
                    nextSequence: 0,
                }),
            ),
            unobserve: vi.fn(),
            takeOver: vi.fn(() => ({ expiresAt: Date.now() + 12_000 })),
            renewTakeOver: vi.fn(() => ({ expiresAt: Date.now() + 12_000 })),
            releaseTakeOver: vi.fn(),
            processId: vi.fn(() => 42),
            reassignSession: vi.fn(),
            reconcileOutputRecoverySettings: vi.fn(),
            resize: vi.fn(() => true),
            resources: vi.fn(() => Promise.resolve(null)),
            restartBarrier: vi.fn(),
            runningCount: vi.fn(() => 1),
            shutdown: vi.fn<TerminalExecutionOwner['shutdown']>(() => []),
            signalExact: vi.fn(() => true),
            snapshot,
            start,
            waitForAttachedSize: vi.fn(async () => {}),
            write,
        },
    };
}

function createRuntime(
    engine: TerminalExecutionOwner,
    agentLauncher?: ManagedAgentExecutionOwner,
): {
    logger: StructuredLogger;
    messages: TerminalHostMessage[];
    runtime: TerminalHostRuntime;
    protocolViolation: ReturnType<typeof vi.fn>;
} {
    const directory = mkdtempSync(join(tmpdir(), 'caxri-terminal-host-runtime-'));
    temporaryDirectories.push(directory);
    const messages: TerminalHostMessage[] = [];
    const protocolViolation = vi.fn();
    const logger = new StructuredLogger(join(directory, 'logs'), 'terminal-host');
    loggers.push(logger);
    return {
        logger,
        messages,
        protocolViolation,
        runtime: new TerminalHostRuntime({
            appVersion: '0.0.18',
            bootId,
            buildId: 'build-1',
            commit: 'deadbeef',
            credential,
            agentLauncher,
            engine,
            logger,
            onProtocolViolation: protocolViolation,
            send: (message) => messages.push(message),
        }),
    };
}

afterEach(async () => {
    /**
     * Await the async writers before deleting their directories, which otherwise races with log creation in CI.
     */
    await Promise.all(loggers.map((logger) => logger.flush()));
    loggers.length = 0;
    for (const directory of temporaryDirectories)
        rmSync(directory, { force: true, recursive: true });
    temporaryDirectories.length = 0;
});

describe('architecture-a3b-terminal-host: TerminalHostRuntime', () => {
    it('keeps a mobile observer and size lease separate from the desktop attachment', async () => {
        const engine = fakeEngine();
        const { messages, runtime } = createRuntime(engine.owner);
        const scope = {
            scope: 'terminal' as const,
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        };
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.start',
                    params: {
                        record: terminal,
                        executable: '/bin/zsh',
                        args: [],
                        environment: {},
                    },
                },
                { ...scope, capability: 'terminal.lifecycle' },
                'start-mobile-terminal',
            ),
        );
        await runtime.accept(
            privateRequest(
                { method: 'terminal.observe', params: { observerId: 'observer-1' } },
                { ...scope, capability: 'terminal.observe' },
                'observe-mobile-terminal',
            ),
        );
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.takeOver',
                    params: {
                        holderId: 'connection:subscription',
                        size: { cols: 42, rows: 20 },
                        timeoutMs: 12_000,
                    },
                },
                { ...scope, capability: 'terminal.lease' },
                'lease-mobile-terminal',
            ),
        );
        expect(engine.owner.observe).toHaveBeenCalledWith(terminal.id, 'observer-1');
        expect(engine.owner.takeOver).toHaveBeenCalledWith(
            terminal.id,
            'connection:subscription',
            { cols: 42, rows: 20 },
            12_000,
        );
        expect(messages.filter((message) => message.type === 'reply')).toHaveLength(3);
        expect(engine.owner.attach).not.toHaveBeenCalled();
    });
    it('keeps Agent credentials in the one-time child plan and projects child exit separately', async () => {
        const engine = fakeEngine();
        const prepare = vi.fn(() => ({
            environment: {
                CAXRI_AGENT_LAUNCHER_RUNTIME: '/runtime/node',
                CAXRI_AGENT_LAUNCHER_ENTRY: '/bundles/agent-launcher.js',
                CAXRI_AGENT_LAUNCHER_SOCKET: '/tmp/agent.sock',
                CAXRI_AGENT_LAUNCHER_ID: 'launch-1',
                CAXRI_AGENT_LAUNCHER_TOKEN: 'one-time-token',
            },
            started: Promise.resolve(101),
        }));
        const agentLauncher: ManagedAgentExecutionOwner = {
            cancel: vi.fn(() => Promise.resolve(true)),
            close: vi.fn(() => Promise.resolve()),
            prepare,
            signalExact: vi.fn(() => true),
        };
        const { messages, runtime } = createRuntime(engine.owner, agentLauncher);
        const agentTerminal: TerminalRecord = {
            ...terminal,
            kind: 'codex',
            provider: 'codex',
            lastAgentProcessState: 'starting',
        };
        const lifecycleScope = {
            scope: 'terminal',
            capability: 'terminal.lifecycle',
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        } as const;

        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.start',
                    params: {
                        record: agentTerminal,
                        executable: '/bin/zsh',
                        args: ['-l'],
                        environment: { TERM: 'xterm-256color' },
                        agent: {
                            launchId: 'launch-1',
                            provider: 'codex',
                            executable: '/usr/local/bin/codex',
                            args: ['resume', 'conversation-1'],
                            environment: { CAXRI_AGENT_ENDPOINT_TOKEN: 'agent-secret' },
                        },
                    },
                },
                lifecycleScope,
                'start-agent-1',
            ),
        );

        expect(prepare).toHaveBeenCalledWith({
            terminalId: terminal.id,
            launchId: 'launch-1',
            plan: {
                executable: '/usr/local/bin/codex',
                args: ['resume', 'conversation-1'],
                environment: { CAXRI_AGENT_ENDPOINT_TOKEN: 'agent-secret' },
                cwd: terminal.cwd,
            },
        });
        const shellLaunch = engine.start.mock.calls[0]?.[0];
        expect(shellLaunch).toMatchObject({
            executable: '/bin/zsh',
            environment: {
                TERM: 'xterm-256color',
                CAXRI_AGENT_LAUNCHER_ID: 'launch-1',
            },
        });
        expect(shellLaunch.environment).not.toHaveProperty('CAXRI_AGENT_ENDPOINT_TOKEN');

        runtime.projectManagedAgentEvent({
            type: 'started',
            terminalId: terminal.id,
            launchId: 'launch-1',
            processId: 101,
        });
        const inputScope = {
            ...lifecycleScope,
            capability: 'terminal.input',
            attachmentId: 'attachment-1',
        } as const;
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.attach',
                    params: { attachmentId: 'attachment-1' },
                },
                { ...inputScope, capability: 'terminal.view' },
                'attach-agent-1',
            ),
        );
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.input',
                    params: { data: 'summary', expectedAgentLaunchId: 'launch-1' },
                },
                inputScope,
                'input-agent-1',
            ),
        );
        expect(engine.write).toHaveBeenCalledWith(terminal.id, 'summary');
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.input',
                    params: {
                        data: '\u{1B}[M \u{80}\u{FF}',
                        encoding: 'binary',
                        expectedAgentLaunchId: 'launch-1',
                    },
                },
                inputScope,
                'input-agent-mouse',
            ),
        );
        expect(engine.write).toHaveBeenCalledWith(
            terminal.id,
            Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0x80, 0xff]),
        );
        runtime.projectManagedAgentEvent({
            type: 'exited',
            terminalId: terminal.id,
            launchId: 'launch-1',
            exitCode: 0,
            signal: null,
        });
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.input',
                    params: { data: 'stale', expectedAgentLaunchId: 'launch-1' },
                },
                inputScope,
                'input-agent-stale',
            ),
        );
        expect(engine.write).toHaveBeenCalledTimes(2);
        expect(messages.at(-1)).toMatchObject({
            type: 'reply',
            id: 'input-agent-stale',
            ok: false,
            error: { code: 'CONFLICT' },
        });
        expect(messages).toContainEqual(
            expect.objectContaining({ event: 'terminal.agent.started', processId: 101 }),
        );
        expect(messages).toContainEqual(
            expect.objectContaining({ event: 'terminal.agent.exit', exitCode: 0 }),
        );
        expect(messages).not.toContainEqual(expect.objectContaining({ event: 'terminal.exit' }));
    });

    it('records successful PTY restarts without retaining Terminal identity', async () => {
        const engine = fakeEngine();
        const { logger, runtime } = createRuntime(engine.owner);
        const lifecycleScope = {
            scope: 'terminal',
            capability: 'terminal.lifecycle',
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        } as const;
        const start = (ptyGeneration: number, id: string) =>
            runtime.accept(
                privateRequest(
                    {
                        method: 'terminal.start',
                        params: {
                            record: terminal,
                            executable: '/bin/zsh',
                            args: [],
                            environment: {},
                        },
                    },
                    { ...lifecycleScope, ptyGeneration },
                    id,
                ),
            );

        await start(1, 'start-1');
        await runtime.accept(
            privateRequest(
                { method: 'terminal.stop', params: { persistSnapshot: true } },
                lifecycleScope,
                'stop-1',
            ),
        );
        await start(2, 'start-2');

        expect(logger.metricSnapshot().series).toContainEqual({
            average: 1,
            count: 1,
            labels: { owner: 'terminal-host', phase: 'startup', outcome: 'restart' },
            last: 1,
            maximum: 1,
            minimum: 1,
            name: 'process.restarts',
            total: 1,
        });
        expect(JSON.stringify(logger.metricSnapshot())).not.toContain(terminal.id);
    });

    it('rejects observation while a stopped PTY is still capturing its restart snapshot', async () => {
        const engine = fakeEngine();
        const capture = Promise.withResolvers<null>();
        engine.owner.restartBarrier.mockReturnValue(capture.promise);
        const { messages, runtime } = createRuntime(engine.owner);
        const scope = {
            scope: 'terminal' as const,
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        };
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.start',
                    params: { record: terminal, executable: '/bin/zsh', args: [], environment: {} },
                },
                { ...scope, capability: 'terminal.lifecycle' },
                'start-before-restart',
            ),
        );

        const stopping = runtime.accept(
            privateRequest(
                { method: 'terminal.stop', params: { persistSnapshot: true } },
                { ...scope, capability: 'terminal.lifecycle' },
                'stop-for-restart',
            ),
        );
        await vi.waitFor(() => expect(engine.owner.restartBarrier).toHaveBeenCalledOnce());
        await runtime.accept(
            privateRequest(
                { method: 'terminal.observe', params: { observerId: 'during-restart' } },
                { ...scope, capability: 'terminal.observe' },
                'observe-during-restart',
            ),
        );
        expect(engine.owner.observe).not.toHaveBeenCalled();
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: 'reply',
                id: 'observe-during-restart',
                ok: false,
            }),
        );
        capture.resolve(null);
        await stopping;
    });

    it('fences a reserved generation and dispatches the authorized execution sequence', async () => {
        const engine = fakeEngine();
        const { messages, runtime } = createRuntime(engine.owner);
        const lifecycleScope = {
            scope: 'terminal',
            capability: 'terminal.lifecycle',
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        } as const;
        await runtime.accept(
            privateRequest(
                { method: 'terminal.reserve', params: terminal },
                lifecycleScope,
                'reserve-1',
            ),
        );
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.start',
                    params: {
                        record: terminal,
                        executable: '/bin/zsh',
                        args: ['-l'],
                        environment: { TERM: 'xterm-256color' },
                    },
                },
                lifecycleScope,
                'start-1',
            ),
        );
        const inputScope = {
            ...lifecycleScope,
            capability: 'terminal.input',
            attachmentId: 'attachment-1',
        } as const;
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.attach',
                    params: { attachmentId: 'attachment-1', size: { cols: 120, rows: 40 } },
                },
                { ...inputScope, capability: 'terminal.view' },
                'attach-1',
            ),
        );
        await runtime.accept(
            privateRequest(
                { method: 'terminal.input', params: { data: 'echo safe\r' } },
                inputScope,
                'input-1',
            ),
        );

        expect(engine.start).toHaveBeenCalledOnce();
        expect(engine.attach).toHaveBeenCalledWith(terminal.id, { cols: 120, rows: 40 });
        expect(engine.write).toHaveBeenCalledWith(terminal.id, 'echo safe\r');
        expect(messages.at(-1)).toEqual({
            type: 'reply',
            id: 'input-1',
            ok: true,
            result: { accepted: true },
        });
    });

    it('rejects stale generations without disclosing the authorization reason', async () => {
        const engine = fakeEngine();
        const { messages, runtime } = createRuntime(engine.owner);
        const lifecycleScope = {
            scope: 'terminal',
            capability: 'terminal.lifecycle',
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        } as const;
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.start',
                    params: {
                        record: terminal,
                        executable: '/bin/zsh',
                        args: [],
                        environment: {},
                    },
                },
                lifecycleScope,
                'start-1',
            ),
        );
        await runtime.accept(
            privateRequest(
                { method: 'terminal.snapshot', params: {} },
                {
                    ...lifecycleScope,
                    capability: 'terminal.view',
                    ptyGeneration: 2,
                },
                'snapshot-stale',
            ),
        );

        expect(messages.at(-1)).toEqual({
            type: 'reply',
            id: 'snapshot-stale',
            ok: false,
            error: {
                code: 'CAPABILITY_DENIED',
                message: 'Terminal Host request was not authorized',
            },
        });
        expect(engine.snapshot).not.toHaveBeenCalled();
    });

    it('fails closed on malformed or oversized parent messages', async () => {
        const { protocolViolation, runtime } = createRuntime(fakeEngine().owner);
        await runtime.accept({ type: 'request', credential: 'secret' });
        expect(protocolViolation).toHaveBeenCalledOnce();
    });

    it('correlates failures without logging private request parameters', async () => {
        const engine = fakeEngine();
        engine.start.mockImplementation(() => {
            throw new Error('private-environment-value');
        });
        const { logger, runtime } = createRuntime(engine.owner);
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.start',
                    params: {
                        record: terminal,
                        executable: '/bin/zsh',
                        args: ['private-argument'],
                        environment: { PRIVATE_TOKEN: 'private-environment-value' },
                    },
                },
                {
                    scope: 'terminal',
                    capability: 'terminal.lifecycle',
                    sessionId: terminal.sessionId,
                    terminalId: terminal.id,
                    ptyGeneration: 1,
                },
                'start-failure-1',
                {
                    requestId: 'public-request-1',
                    traceId: 'public-trace-1',
                },
            ),
        );
        await logger.flush();

        const log = await readFile(logger.path, 'utf8');
        expect(log).toContain('"event":"terminal_host.request_failed"');
        expect(log).toContain('"correlationId":"start-failure-1"');
        expect(log).toContain('"method":"terminal.start"');
        expect(log).toContain('"traceId":"public-trace-1"');
        expect(log).not.toContain('private-argument');
        expect(log).not.toContain('private-environment-value');
        expect(log).not.toContain('PRIVATE_TOKEN');
    });

    it('captures every settled snapshot and reports per-terminal failures when one Terminal rejects during host.shutdown', async () => {
        const engine = fakeEngine();
        const entries = Array.from({ length: 11 }, (_, index) => {
            const terminalId = `terminal-${index}`;
            const capture =
                index === 5
                    ? Promise.reject(new Error('parser barrier stuck'))
                    : Promise.resolve({
                          terminalId,
                          encodingVersion: 1,
                          cols: 80,
                          rows: 24,
                          lineCount: 1,
                          byteCount: 1,
                          payload: 'x',
                          updatedAt: 1,
                      });
            return { terminalId, capture };
        });
        const shutdownMock = vi.fn(() => entries);
        engine.owner.shutdown = shutdownMock;
        const { messages, runtime } = createRuntime(engine.owner);

        await runtime.accept(
            privateRequest(
                { method: 'host.shutdown', params: {} },
                { scope: 'server', capability: 'host.lifecycle' },
                'shutdown-1',
            ),
        );

        expect(shutdownMock).toHaveBeenCalledOnce();
        const reply = messages.at(-1) as {
            type: 'reply';
            id: string;
            ok: true;
            result: {
                snapshots: unknown[];
                failures?: Array<{ terminalId: string; error: string }>;
            };
        };
        expect(reply).toMatchObject({ type: 'reply', id: 'shutdown-1', ok: true });
        expect(reply.result.snapshots).toHaveLength(10);
        expect(reply.result.failures).toEqual([
            { terminalId: 'terminal-5', error: 'parser barrier stuck' },
        ]);
    });

    it('memoizes the shutdown capture so a later stopAfterParentDisconnect reuses the host.shutdown result', async () => {
        const engine = fakeEngine();
        const capture = Promise.resolve({
            terminalId: terminal.id,
            encodingVersion: 1,
            cols: 80,
            rows: 24,
            lineCount: 1,
            byteCount: 1,
            payload: 'x',
            updatedAt: 1,
        });
        const shutdownMock = vi.fn(() => [{ terminalId: terminal.id, capture }]);
        engine.owner.shutdown = shutdownMock;
        const { messages, runtime } = createRuntime(engine.owner);

        await runtime.accept(
            privateRequest(
                { method: 'host.shutdown', params: {} },
                { scope: 'server', capability: 'host.lifecycle' },
                'shutdown-1',
            ),
        );
        await runtime.stopAfterParentDisconnect();

        expect(shutdownMock).toHaveBeenCalledOnce();
        const reply = messages.at(-1) as { result: { snapshots: unknown[] } };
        expect(reply.result.snapshots).toHaveLength(1);
    });

    it('waitForShutdownRequest resolves once a shutdown capture begins and times out otherwise', async () => {
        const engine = fakeEngine();
        const { runtime } = createRuntime(engine.owner);

        await expect(runtime.waitForShutdownRequest(20)).resolves.toBe(false);

        engine.owner.shutdown = vi.fn(() => [
            {
                terminalId: terminal.id,
                capture: Promise.resolve({
                    terminalId: terminal.id,
                    encodingVersion: 1,
                    cols: 80,
                    rows: 24,
                    lineCount: 1,
                    byteCount: 1,
                    payload: 'x',
                    updatedAt: 1,
                }),
            },
        ]);
        const shutdownReply = runtime.accept(
            privateRequest(
                { method: 'host.shutdown', params: {} },
                { scope: 'server', capability: 'host.lifecycle' },
                'shutdown-2',
            ),
        );

        await expect(runtime.waitForShutdownRequest(1_000)).resolves.toBe(true);
        await shutdownReply;
    });
});
