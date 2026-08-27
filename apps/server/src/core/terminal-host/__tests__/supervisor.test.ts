import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWithObservationContext, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalHostRequestEnvelope } from '../../../terminal-host/protocol';
import { TerminalHostSupervisor } from '../supervisor';

const bootId = 'b'.repeat(32);
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
    supervisor: TerminalHostSupervisor;
} {
    const child = new FakeChild();
    const forkProcess = vi.fn(() => child as unknown as ChildProcess);
    const directory = mkdtempSync(join(tmpdir(), 'caxri-terminal-host-supervisor-'));
    temporaryDirectories.push(directory);
    return {
        child,
        forkProcess,
        supervisor: new TerminalHostSupervisor({
            appVersion: '0.0.18',
            bootId,
            buildId: 'build-1',
            commit: 'deadbeef',
            e2eAgentPolicy: { mode: 'real', provider: 'codex' },
            forkProcess,
            logger: new StructuredLogger(join(directory, 'logs'), 'server-core'),
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
        protocolVersion: 1,
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

afterEach(() => {
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
        await becomeReady(child, supervisor);

        expect(forkProcess).toHaveBeenCalledOnce();
        const launchOptions = forkProcess.mock.calls[0][2] as {
            env: Record<string, string>;
            execArgv: string[];
        };
        expect(launchOptions.execArgv).toEqual(['--max-semi-space-size=8']);
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
        const failedDiagnostics = supervisor.diagnostics();
        expect(failedDiagnostics).toMatchObject({
            state: 'failed',
            restartCount: 0,
            pendingRequestCount: 0,
            lastExit: { code: 9, signal: null },
        });
        expect(typeof failedDiagnostics.lastExit?.at).toBe('number');
    });
});
