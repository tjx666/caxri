import { EventEmitter } from 'node:events';

import type { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostRuntimeSupervisor } from '../runtime-supervisor';

// Mocks Node's ChildProcess, which is itself an EventEmitter and is consumed via
// `.on()`/`.emit()` by the production supervisor; EventTarget is not a drop-in replacement here.
// eslint-disable-next-line unicorn/prefer-event-target -- interoperates with Node's EventEmitter-based ChildProcess API
class FakeChild extends EventEmitter {
    connected = true;
    pid = 42;
    kill = vi.fn(() => true);
    send = vi.fn<(message: unknown, callback?: (error: Error | null) => void) => boolean>(
        () => true,
    );
}

function options() {
    return {
        appVersion: '1.0.0',
        commit: 'abc1234',
        logDirectory: '/logs',
        logger: { write: vi.fn() } as unknown as StructuredLogger,
        runtimePath: '/runtime.js',
        userDataPath: '/profile',
    };
}

afterEach(() => vi.useRealTimers());

describe('Host Runtime supervisor', () => {
    it('launches Electron Node mode and correlates Runtime requests', async () => {
        const child = new FakeChild();
        const fork = vi.fn(() => child as never);
        const supervisor = new HostRuntimeSupervisor(options(), fork);
        const starting = supervisor.start();
        child.emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
        await starting;
        const call = fork.mock.calls[0] as unknown as [
            string,
            string[],
            { env: NodeJS.ProcessEnv; serialization: string; stdio: string[] },
        ];
        expect(call[0]).toBe('/runtime.js');
        expect(call[1]).toEqual([]);
        expect(call[2].env.ELECTRON_RUN_AS_NODE).toBe('1');
        expect(call[2].serialization).toBe('advanced');
        expect(call[2].stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc']);

        const health = supervisor.request('app.health');
        await Promise.resolve();
        const request = child.send.mock.calls.at(-1)?.[0] as { id: string };
        child.emit('message', {
            id: request.id,
            ok: true,
            result: { ready: true, pid: 42, startedAt: 1, activePtyCount: 0 },
        });
        await expect(health).resolves.toMatchObject({ ready: true, pid: 42 });
    });

    it('correlates private Agent Endpoint control without publishing a Runtime event', async () => {
        const child = new FakeChild();
        const agentEndpointControl = vi.fn(() => ({
            ref: { hostId: 'a'.repeat(32), endpointId: 'endpoint-1', generation: 1 },
            token: 'ab'.repeat(32),
            expiresAt: 10_000,
        }));
        const supervisor = new HostRuntimeSupervisor(
            { ...options(), agentEndpointControl },
            vi.fn(() => child as never),
        );
        const event = vi.fn();
        supervisor.onEvent(event);
        const starting = supervisor.start();
        child.emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
        await starting;
        child.send.mockClear();

        child.emit('message', {
            type: 'host-control.request',
            id: 'control-1',
            operation: 'agent-endpoint.begin',
            params: {
                terminalId: 'terminal-1',
                sessionId: 'session-1',
                projectId: 'project-1',
                provider: 'codex',
                launchId: 'launch-1',
                name: 'Codex',
                permissionClass: 'standard',
                messaging: {
                    deliveryMode: 'unavailable',
                    health: 'unsupported',
                    reason: 'adapter_unavailable',
                    checkedAt: 1,
                    nextAction: 'restart_terminal',
                },
            },
        });
        await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(1));

        expect(agentEndpointControl).toHaveBeenCalledOnce();
        expect(child.send).toHaveBeenCalledWith({
            type: 'host-control.reply',
            id: 'control-1',
            ok: true,
            result: {
                ref: { hostId: 'a'.repeat(32), endpointId: 'endpoint-1', generation: 1 },
                token: 'ab'.repeat(32),
                expiresAt: 10_000,
            },
        });
        expect(event).toHaveBeenCalledTimes(1);
    });

    it('restarts a crashed Runtime with a bounded backoff', async () => {
        vi.useFakeTimers();
        const first = new FakeChild();
        const second = new FakeChild();
        const fork = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
        const supervisor = new HostRuntimeSupervisor(options(), fork as never);
        const starting = supervisor.start();
        first.emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
        await starting;
        const runtimeExit = vi.fn();
        supervisor.onRuntimeExit(runtimeExit);
        first.emit('exit', 1);
        expect(runtimeExit).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(250);
        expect(fork).toHaveBeenCalledTimes(2);
        second.emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
    });

    it('fails readiness with a stable timeout instead of waiting forever', async () => {
        vi.useFakeTimers();
        const child = new FakeChild();
        const supervisor = new HostRuntimeSupervisor(
            options(),
            vi.fn(() => child as never),
        );
        const starting = supervisor.start();
        const failed = expect(starting).rejects.toMatchObject({ code: 'TIMEOUT' });
        await vi.advanceTimersByTimeAsync(15_000);
        await failed;
        expect(child.kill).toHaveBeenCalled();
    });

    it('propagates an Extension API cancellation to Runtime and settles the Host waiter', async () => {
        const child = new FakeChild();
        const supervisor = new HostRuntimeSupervisor(
            options(),
            vi.fn(() => child as never),
        );
        const starting = supervisor.start();
        child.emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
        await starting;
        child.send.mockClear();

        const controller = new AbortController();
        const pending = supervisor.requestInWorkbenchContext(
            'files.list',
            { sessionId: 'session-1' },
            { sessionId: 'session-1', workbenchProjectId: 'project-1' },
            undefined,
            controller.signal,
        );
        await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(1));
        const request = child.send.mock.calls[0][0] as { id: string; method: string };
        expect(request.method).toBe('files.list');

        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(child.send).toHaveBeenLastCalledWith({ type: 'cancel', id: request.id });
    });
});
