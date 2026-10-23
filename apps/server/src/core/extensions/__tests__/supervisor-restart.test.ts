import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionHostRequest } from '../../../extension-host/protocol';
import { ExtensionHostSupervisor } from '../supervisor';

vi.mock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal()),
    fork: vi.fn(),
}));

const observationIdentity = {
    bootId: 'b'.repeat(32),
    buildId: 'build-1',
    serverId: 'c'.repeat(32),
    userDataPath: '/tmp/caxri-extension-supervisor-test',
};

afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
});

describe('ExtensionHostSupervisor restart', () => {
    function forkRestartableChildren(): Array<EventEmitter & ChildProcess> {
        const children: Array<EventEmitter & ChildProcess> = [];
        vi.mocked(fork).mockImplementation(() => {
            // ChildProcess uses Node's EventEmitter contract; this fake exercises only owned IPC lifecycle.
            // eslint-disable-next-line unicorn/prefer-event-target
            const child = Object.assign(new EventEmitter(), {
                connected: true,
                exitCode: null as number | null,
                signalCode: null,
                pid: 200 + children.length,
                kill: vi.fn(() => {
                    child.connected = false;
                    child.exitCode = 0;
                    queueMicrotask(() => child.emit('exit', 0));
                    return true;
                }),
                send: vi.fn((message: ExtensionHostRequest) => {
                    if (message.method === 'configure' || message.method === 'shutdown')
                        queueMicrotask(() => {
                            child.emit('message', {
                                type: 'reply',
                                id: message.id,
                                ok: true,
                                result:
                                    message.method === 'configure'
                                        ? { configured: 0 }
                                        : { stopped: true },
                            });
                            if (message.method === 'shutdown') child.kill();
                        });
                    return true;
                }),
            });
            children.push(child as unknown as EventEmitter & ChildProcess);
            return child as unknown as ChildProcess;
        });
        return children;
    }

    function createSupervisor(
        requestApi: ConstructorParameters<typeof ExtensionHostSupervisor>[0]['requestApi'],
    ): ExtensionHostSupervisor {
        return new ExtensionHostSupervisor({
            ...observationIdentity,
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            logger: new StructuredLogger(
                '/tmp/caxri-extension-supervisor-test',
                'server-core',
                'error',
            ),
            registrations: () => [],
            requestApi,
        });
    }

    it('fails requests waiting on the retired child readiness instead of letting them hang', async () => {
        vi.useFakeTimers();
        const children = forkRestartableChildren();
        const supervisor = createSupervisor(() => Promise.resolve({}));
        const outcome = (promise: Promise<unknown>): { error?: unknown; settled: boolean } => {
            const state: { error?: unknown; settled: boolean } = { settled: false };
            // Observed without awaiting: the assertion is that the promise already settled, not that it eventually does.
            void (async () => {
                try {
                    await promise;
                } catch (error) {
                    state.error = error;
                }
                state.settled = true;
            })();
            return state;
        };
        const startup = outcome(supervisor.start());
        const activation = outcome(
            supervisor.request('activate', {
                extensionId: 'publisher.fixture',
                generation: 1,
                reason: 'onView:publisher.fixture.tree',
            }),
        );

        const restarted = supervisor.restart();
        await vi.waitFor(() => expect(children).toHaveLength(2));
        children[1].emit('message', { type: 'ready' });
        await restarted;
        await vi.advanceTimersByTimeAsync(0);

        expect(startup).toMatchObject({ settled: true, error: expect.any(Error) as Error });
        expect(activation).toMatchObject({ settled: true, error: expect.any(Error) as Error });
        await supervisor.shutdown();
    });

    it('aborts Extension API requests the retired child still had in flight', async () => {
        const children = forkRestartableChildren();
        const signals: Array<AbortSignal | undefined> = [];
        const supervisor = createSupervisor((_request, signal) => {
            signals.push(signal);
            return new Promise(() => {});
        });
        const started = supervisor.start();
        children[0].emit('message', { type: 'ready' });
        await started;
        children[0].emit('message', {
            type: 'api-request',
            id: 'retired-api-request',
            extensionId: 'publisher.fixture',
            generation: 1,
            apiToken: 'fixture-token-1',
            method: 'workspace.getProjectStatus',
            params: {},
        });
        await vi.waitFor(() => expect(signals).toHaveLength(1));

        const restarted = supervisor.restart();
        await vi.waitFor(() => expect(children).toHaveLength(2));
        children[1].emit('message', { type: 'ready' });
        await restarted;

        expect(signals[0]?.aborted).toBe(true);
        await supervisor.shutdown();
    });

    it('records the killing signal of an unexpected exit instead of a fabricated code', async () => {
        vi.useFakeTimers();
        const children = forkRestartableChildren();
        const supervisor = createSupervisor(() => Promise.resolve({}));
        const write = vi.spyOn(StructuredLogger.prototype, 'write');
        const started = supervisor.start();
        children[0].emit('message', { type: 'ready' });
        await started;

        children[0].emit('exit', null, 'SIGSEGV');

        expect(write).toHaveBeenCalledWith(
            'error',
            'extension_host.exit',
            expect.objectContaining({ fields: { code: null, signal: 'SIGSEGV' } }),
        );
        await vi.advanceTimersByTimeAsync(250);
        expect(children).toHaveLength(2);
        children[1].emit('message', { type: 'ready' });
        await supervisor.shutdown();
    });

    it('treats an exit after Server Core started stopping as teardown and never restarts it', async () => {
        vi.useFakeTimers();
        const children = forkRestartableChildren();
        const supervisor = createSupervisor(() => Promise.resolve({}));
        const write = vi.spyOn(StructuredLogger.prototype, 'write');
        const exits: Array<number | null> = [];
        supervisor.onExit((code) => exits.push(code));
        const started = supervisor.start();
        children[0].emit('message', { type: 'ready' });
        await started;

        supervisor.markCoreStopping();
        children[0].emit('exit', null, 'SIGTERM');
        await vi.advanceTimersByTimeAsync(5_000);

        expect(write).toHaveBeenCalledWith(
            'warn',
            'extension_host.exit',
            expect.objectContaining({
                fields: { code: null, signal: 'SIGTERM', source: 'core-stopping' },
            }),
        );
        expect(write).not.toHaveBeenCalledWith('error', 'extension_host.exit', expect.anything());
        expect(exits).toEqual([]);
        expect(children).toHaveLength(1);
        await supervisor.shutdown();
    });
});
