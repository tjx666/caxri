import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWithObservationContext, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalHostRequestEnvelope } from '../../../terminal-host/protocol';
import { TERMINAL_HOST_PROTOCOL_VERSION } from '../../../terminal-host/protocol';
import { TerminalHostSupervisor } from '../supervisor';

const bootId = 'b'.repeat(32);
const loggers: StructuredLogger[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

async function flushLoggers(): Promise<void> {
    const pendingLoggers = [...loggers];
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
}
const temporaryDirectories: string[] = [];

// eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess exposes EventEmitter, which this test seam mirrors.
class FakeChild extends EventEmitter {
    connected = true;
    exitCode: number | null = null;
    pid = 4242;
    signalCode: NodeJS.Signals | null = null;
    readonly sent: TerminalHostRequestEnvelope[] = [];

    kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
        if (this.exitCode !== null || this.signalCode !== null) return false;
        this.connected = false;
        this.signalCode = signal;
        queueMicrotask(() => this.emit('exit', 0, signal));
        return true;
    }

    send(message: TerminalHostRequestEnvelope, callback?: (error: Error | null) => void): boolean {
        this.sent.push(message);
        callback?.(null);
        return true;
    }
}

function createSupervisor(): {
    child: FakeChild;
    forkProcess: ReturnType<typeof vi.fn>;
    logger: StructuredLogger;
    supervisor: TerminalHostSupervisor;
} {
    const child = new FakeChild();
    const forkProcess = vi.fn(() => child as unknown as ChildProcess);
    const directory = mkdtempSync(join(tmpdir(), 'caxri-terminal-host-supervisor-'));
    temporaryDirectories.push(directory);
    const logger = createLogger(join(directory, 'logs'), 'server-core');
    return {
        child,
        forkProcess,
        logger,
        supervisor: new TerminalHostSupervisor({
            appVersion: '0.0.18',
            bootId,
            buildId: 'build-1',
            commit: 'deadbeef',
            e2eAgentPolicy: { mode: 'real', provider: 'codex' },
            forkProcess,
            logger,
            outputFlushMs: 1_000,
            terminalHostPath: '/out/main/terminal-host.js',
            userDataPath: directory,
        }),
    };
}

async function becomeReady(child: FakeChild, supervisor: TerminalHostSupervisor): Promise<void> {
    const startup = supervisor.start();
    child.emit('message', {
        type: 'event',
        event: 'host.ready',
        bootId,
        protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
        appVersion: '0.0.18',
        buildId: 'build-1',
        commit: 'deadbeef',
        pid: child.pid,
    });
    await vi.waitFor(() => expect(child.sent).toHaveLength(1));
    child.emit('message', {
        type: 'reply',
        id: child.sent[0].id,
        ok: true,
        result: { initialized: true },
    });
    await startup;
}

afterEach(async () => {
    await flushLoggers();
    for (const directory of temporaryDirectories)
        rmSync(directory, { force: true, recursive: true });
    temporaryDirectories.length = 0;
});

describe('architecture-a3b-terminal-host: TerminalHostSupervisor', () => {
    it('launches with an inherited private credential and initializes the exact build', async () => {
        const { child, forkProcess, supervisor } = createSupervisor();
        expect(supervisor.diagnostics()).toEqual({
            state: 'idle',
            restartCount: 0,
            pendingRequestCount: 0,
        });
        expect(supervisor.isRunning()).toBe(false);
        await becomeReady(child, supervisor);

        expect(supervisor.isRunning()).toBe(true);
        expect(forkProcess).toHaveBeenCalledOnce();
        const launchOptions = forkProcess.mock.calls[0][2] as {
            env: Record<string, string>;
            execArgv: string[];
        };
        // The inspector port is on by default (`packages/protocol/src/desktop/debug-launch.ts`); the Terminal Host
        // takes offset 2 off the base so it never collides with Server Core or the Extension Host.
        expect(launchOptions.execArgv).toEqual(['--max-semi-space-size=8', '--inspect=9231']);
        expect(launchOptions.env.CAXRI_TERMINAL_HOST_CREDENTIAL).toMatch(/^[0-9a-f]{64}$/u);
        expect(launchOptions.env.CAXRI_SERVER_BOOT_ID).toBe(bootId);
        expect(launchOptions.env.CAXRI_E2E).toBe('1');
        expect(launchOptions.env.CAXRI_E2E_AGENT_MODE).toBe('real');
        expect(launchOptions.env.CAXRI_E2E_AGENT_PROVIDER).toBe('codex');
        expect(launchOptions.env.CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS).toBe('1000');
        expect(child.sent[0]).toMatchObject({
            bootId,
            credential: launchOptions.env.CAXRI_TERMINAL_HOST_CREDENTIAL,
            request: { method: 'host.initialize' },
        });
        const readyDiagnostics = supervisor.diagnostics();
        expect(readyDiagnostics).toMatchObject({
            state: 'ready',
            pid: 4242,
            restartCount: 0,
            pendingRequestCount: 0,
        });
        expect(typeof readyDiagnostics.startedAt).toBe('number');
        await supervisor.shutdown();
        expect(supervisor.diagnostics().state).toBe('stopped');
        expect(supervisor.isRunning()).toBe(false);
    });

    it('rejects a structurally valid reply with the wrong method result', async () => {
        const { child, supervisor } = createSupervisor();
        await becomeReady(child, supervisor);
        const request = supervisor.request(
            { method: 'terminal.runningCount', params: {} },
            { scope: 'server', capability: 'terminal.inspect' },
        );
        await vi.waitFor(() => expect(child.sent).toHaveLength(2));
        child.emit('message', {
            type: 'reply',
            id: child.sent[1].id,
            ok: true,
            result: { count: -1 },
        });

        await expect(request).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        expect(child.connected).toBe(false);
    });

    it('forwards the root trace while keeping the private request identity local', async () => {
        const { child, supervisor } = createSupervisor();
        await becomeReady(child, supervisor);
        const request = runWithObservationContext(
            {
                clientId: 'client-1',
                operationId: 'control-operation-1',
                requestId: 'public-request-1',
                traceId: 'public-trace-1',
            },
            () =>
                supervisor.request(
                    { method: 'terminal.runningCount', params: { sessionId: 'session-1' } },
                    { scope: 'server', capability: 'terminal.inspect' },
                ),
        );
        await vi.waitFor(() => expect(child.sent).toHaveLength(2));

        expect(child.sent[1].observation).toEqual({
            clientId: 'client-1',
            operationId: child.sent[1].id,
            requestId: 'public-request-1',
            traceId: 'public-trace-1',
        });
        child.emit('message', {
            type: 'reply',
            id: child.sent[1].id,
            ok: true,
            result: { count: 0 },
        });
        await expect(request).resolves.toEqual({ count: 0 });
    });

    it('uses the Host result after an Agent input was sent even when admission is revoked', async () => {
        const { child, supervisor } = createSupervisor();
        await becomeReady(child, supervisor);
        const cancellation = new AbortController();
        const request = supervisor.request(
            {
                method: 'terminal.agent.input',
                params: { data: 'Continue\r', launchId: 'launch-1' },
            },
            {
                scope: 'terminal',
                capability: 'terminal.agent.input',
                sessionId: 'session-1',
                terminalId: 'terminal-1',
                ptyGeneration: 1,
            },
            cancellation.signal,
        );
        await vi.waitFor(() => expect(child.sent).toHaveLength(2));
        cancellation.abort();
        child.emit('message', {
            type: 'reply',
            id: child.sent[1].id,
            ok: true,
            result: { accepted: true },
        });

        await expect(request).resolves.toEqual({ accepted: true });
    });

    it('does not send Agent input revoked while the Host starts', async () => {
        const { child, supervisor } = createSupervisor();
        const cancellation = new AbortController();
        const request = supervisor.request(
            {
                method: 'terminal.agent.input',
                params: { data: 'Continue\r', launchId: 'launch-1' },
            },
            {
                scope: 'terminal',
                capability: 'terminal.agent.input',
                sessionId: 'session-1',
                terminalId: 'terminal-1',
                ptyGeneration: 1,
            },
            cancellation.signal,
        );
        cancellation.abort();
        await becomeReady(child, supervisor);

        await expect(request).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(child.sent.map(({ request: sent }) => sent.method)).toEqual(['host.initialize']);
    });

    it('does not send mobile input revoked while the Host starts', async () => {
        const { child, supervisor } = createSupervisor();
        const cancellation = new AbortController();
        const request = supervisor.request(
            { method: 'terminal.observer.input', params: { data: '\u{1B}[A' } },
            {
                scope: 'terminal',
                capability: 'terminal.mobile.input',
                sessionId: 'session-1',
                terminalId: 'terminal-1',
                ptyGeneration: 1,
            },
            cancellation.signal,
        );
        cancellation.abort();
        await becomeReady(child, supervisor);

        await expect(request).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(child.sent.map(({ request: sent }) => sent.method)).toEqual(['host.initialize']);
    });

    it('uses the Host result after mobile input was sent even when admission is revoked', async () => {
        const { child, supervisor } = createSupervisor();
        await becomeReady(child, supervisor);
        const cancellation = new AbortController();
        const request = supervisor.request(
            { method: 'terminal.observer.input', params: { data: '\u{1B}[A' } },
            {
                scope: 'terminal',
                capability: 'terminal.mobile.input',
                sessionId: 'session-1',
                terminalId: 'terminal-1',
                ptyGeneration: 1,
            },
            cancellation.signal,
        );
        await vi.waitFor(() => expect(child.sent).toHaveLength(2));
        cancellation.abort();
        child.emit('message', {
            type: 'reply',
            id: child.sent[1].id,
            ok: true,
            result: { accepted: true },
        });

        await expect(request).resolves.toEqual({ accepted: true });
    });

    it('fences pending requests when the owned child exits', async () => {
        const { child, supervisor } = createSupervisor();
        await becomeReady(child, supervisor);
        const onExit = vi.fn();
        supervisor.onExit(onExit);
        const request = supervisor.request(
            { method: 'terminal.runningCount', params: {} },
            { scope: 'server', capability: 'terminal.inspect' },
        );
        await vi.waitFor(() => expect(child.sent).toHaveLength(2));
        child.exitCode = 9;
        child.emit('exit', 9, null);

        await expect(request).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        expect(onExit).toHaveBeenCalledWith({ code: 9, signal: null });
        expect(supervisor.processId()).toBeUndefined();
        expect(supervisor.isRunning()).toBe(false);
        const failedDiagnostics = supervisor.diagnostics();
        expect(failedDiagnostics).toMatchObject({
            state: 'failed',
            restartCount: 0,
            pendingRequestCount: 0,
            lastExit: { code: 9, signal: null },
        });
        expect(typeof failedDiagnostics.lastExit?.at).toBe('number');
    });

    it('cancels pending requests during an intentional shutdown', async () => {
        const { child, supervisor } = createSupervisor();
        await becomeReady(child, supervisor);
        const resources = supervisor.request(
            { method: 'terminal.resources', params: {} },
            {
                scope: 'terminal',
                capability: 'terminal.inspect',
                sessionId: 'session-1',
                terminalId: 'terminal-1',
                ptyGeneration: 1,
            },
        );
        await vi.waitFor(() => expect(child.sent).toHaveLength(2));

        const shutdown = supervisor.shutdown();
        await vi.waitFor(() => expect(child.sent).toHaveLength(3));
        child.emit('message', {
            type: 'reply',
            id: child.sent[2].id,
            ok: true,
            result: { snapshots: [], stopped: true },
        });

        await expect(resources).rejects.toMatchObject({ code: 'CANCELLED' });
        await expect(shutdown).resolves.toEqual({ failures: [], snapshots: [] });
    });

    it('scales the host.shutdown timeout with the live Terminal count and logs shutdownFailed once it elapses', async () => {
        const { child, logger, supervisor } = createSupervisor();
        await becomeReady(child, supervisor);

        vi.useFakeTimers();
        try {
            // 3 live Terminals: MIN_SHUTDOWN_TIMEOUT_MS (5_000) + 3 * SHUTDOWN_TIMEOUT_PER_TERMINAL_MS (1_000) = 8_000.
            const shutdown = supervisor.shutdown(3);
            await vi.advanceTimersByTimeAsync(7_999);
            expect(supervisor.diagnostics().pendingRequestCount).toBe(1);

            await vi.advanceTimersByTimeAsync(1);
            await shutdown;
            expect(supervisor.diagnostics().pendingRequestCount).toBe(0);
        } finally {
            vi.useRealTimers();
        }

        await logger.flush();
        const log = await readFile(logger.path, 'utf8');
        expect(log).toContain('"event":"terminal_host.shutdown_failed"');
        expect(log).toContain('"timeoutMs":8000');
        expect(log).toContain('"expectedSnapshotCount":3');
    });

    it('caps the scaled host.shutdown timeout at MAX_SHUTDOWN_TIMEOUT_MS', async () => {
        const { child, logger, supervisor } = createSupervisor();
        await becomeReady(child, supervisor);

        vi.useFakeTimers();
        try {
            const shutdown = supervisor.shutdown(100);
            await vi.advanceTimersByTimeAsync(30_000);
            await shutdown;
        } finally {
            vi.useRealTimers();
        }

        await logger.flush();
        const log = await readFile(logger.path, 'utf8');
        expect(log).toContain('"event":"terminal_host.shutdown_failed"');
        expect(log).toContain('"timeoutMs":30000');
        expect(log).toContain('"expectedSnapshotCount":100');
    });
});
