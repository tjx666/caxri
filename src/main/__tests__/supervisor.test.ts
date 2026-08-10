import { afterEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
    type Listener = (...args: unknown[]) => void;
    interface FakeEmitter {
        emit(event: string, ...args: unknown[]): void;
        on(event: string, listener: Listener): FakeEmitter;
    }
    interface FakeChild extends FakeEmitter {
        kill: ReturnType<typeof vi.fn>;
        postMessage: ReturnType<typeof vi.fn>;
        stdout: FakeEmitter;
        stderr: FakeEmitter;
    }

    function createEmitter(): FakeEmitter {
        const listeners = new Map<string, Listener[]>();
        const emitter: FakeEmitter = {
            emit(event, ...args) {
                for (const listener of listeners.get(event) ?? []) listener(...args);
            },
            on(event, listener) {
                listeners.set(event, [...(listeners.get(event) ?? []), listener]);
                return emitter;
            },
        };
        return emitter;
    }

    const children: FakeChild[] = [];
    const fork = vi.fn(() => {
        const base = createEmitter();
        const child: FakeChild = {
            ...base,
            kill: vi.fn(),
            postMessage: vi.fn(),
            stdout: createEmitter(),
            stderr: createEmitter(),
        };
        children.push(child);
        return child;
    });
    return { children, fork };
});

vi.mock('electron', () => ({ utilityProcess: { fork: electronMock.fork } }));

import type { StructuredLogger } from '../../shared/node/logger';
import { RuntimeSupervisor } from '../supervisor';

interface FakeLogger {
    write: ReturnType<typeof vi.fn>;
}

/**
 * A no-op stand-in for StructuredLogger; these tests never touch the real filesystem. Kept as a
 * plain object type (not `StructuredLogger`) so `logger.write` stays a property reference rather
 * than an unbound class method reference when tests assert on it directly.
 */
function fakeLogger(): FakeLogger {
    return { write: vi.fn() };
}

afterEach(() => {
    vi.useRealTimers();
    electronMock.children.length = 0;
    electronMock.fork.mockClear();
});

describe('RuntimeSupervisor', () => {
    it('settles the original startup promise when a restarted Runtime becomes ready', async () => {
        vi.useFakeTimers();
        const supervisor = new RuntimeSupervisor(
            '/runtime',
            '/user-data',
            '/logs',
            fakeLogger() as unknown as StructuredLogger,
        );
        const started = supervisor.start();
        let settled = false;
        void started.then(() => {
            settled = true;
        });

        electronMock.children[0].emit('exit', 1);
        await vi.advanceTimersByTimeAsync(250);
        electronMock.children[1].emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 1 },
        });
        await Promise.resolve();

        expect(settled).toBe(true);
    });

    it('rejects startup and kills a Runtime that never becomes ready', async () => {
        vi.useFakeTimers();
        const supervisor = new RuntimeSupervisor(
            '/runtime',
            '/user-data',
            '/logs',
            fakeLogger() as unknown as StructuredLogger,
        );
        const started = supervisor.start();
        const rejection = expect(started).rejects.toThrow('did not become ready');

        await vi.advanceTimersByTimeAsync(15_000);

        await rejection;
        expect(electronMock.children[0].kill).toHaveBeenCalledOnce();
    });

    it('does not fork early when a request arrives during a scheduled crash-restart backoff', async () => {
        vi.useFakeTimers();
        const supervisor = new RuntimeSupervisor(
            '/runtime',
            '/user-data',
            '/logs',
            fakeLogger() as unknown as StructuredLogger,
        );
        const started = supervisor.start();
        electronMock.children[0].emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
        await started;
        expect(electronMock.fork).toHaveBeenCalledTimes(1);

        electronMock.children[0].emit('exit', 1);

        /** A request arriving mid-backoff must wait for the scheduled restart, not fork immediately. */
        const request = supervisor.request('terminal.runningCount');
        await Promise.resolve();
        await Promise.resolve();
        expect(electronMock.fork).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(249);
        expect(electronMock.fork).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(electronMock.fork).toHaveBeenCalledTimes(2);

        electronMock.children[1].emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 1 },
        });
        /** Resolving readiness chains through pendingRestart and then the queued send(); flush both hops. */
        for (let flush = 0; flush < 5; flush += 1) await Promise.resolve();
        const sent = electronMock.children[1].postMessage.mock.calls[0][0] as {
            id: string;
            method: string;
        };
        expect(sent.method).toBe('terminal.runningCount');
        electronMock.children[1].emit('message', { id: sent.id, ok: true, result: 0 });

        await expect(request).resolves.toBe(0);
    });

    it('does not restart a Runtime after the readiness deadline has failed closed', async () => {
        vi.useFakeTimers();
        const supervisor = new RuntimeSupervisor(
            '/runtime',
            '/user-data',
            '/logs',
            fakeLogger() as unknown as StructuredLogger,
        );
        const started = supervisor.start();
        const startupRejection = expect(started).rejects.toThrow('did not become ready');

        await vi.advanceTimersByTimeAsync(15_000);
        await startupRejection;

        const request = supervisor.request('app.bootstrap');
        const requestRejection = expect(request).rejects.toThrow('did not become ready');
        await vi.advanceTimersByTimeAsync(15_000);
        await requestRejection;
        expect(electronMock.fork).toHaveBeenCalledTimes(1);
    });

    it('keeps a file copy pending beyond the ordinary request deadline', async () => {
        vi.useFakeTimers();
        const supervisor = new RuntimeSupervisor(
            '/runtime',
            '/user-data',
            '/logs',
            fakeLogger() as unknown as StructuredLogger,
        );
        const started = supervisor.start();
        const child = electronMock.children[0];
        child.emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
        await started;

        const copy = supervisor.forward('files.copy', {
            sessionId: 'session-1',
            path: '/project/source.txt',
            directory: '/project/target',
        });
        await Promise.resolve();
        const sent = child.postMessage.mock.calls[0][0] as { id: string };
        let settled = false;
        void copy.finally(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(20_000);
        expect(settled).toBe(false);

        child.emit('message', {
            id: sent.id,
            ok: true,
            result: {
                kind: 'file',
                name: 'source.txt',
                path: '/project/target/source.txt',
            },
        });
        await expect(copy).resolves.toMatchObject({ path: '/project/target/source.txt' });
    });

    it('lets Runtime cancel a queued save instead of timing it out in Main', async () => {
        vi.useFakeTimers();
        const supervisor = new RuntimeSupervisor(
            '/runtime',
            '/user-data',
            '/logs',
            fakeLogger() as unknown as StructuredLogger,
        );
        const started = supervisor.start();
        const child = electronMock.children[0];
        child.emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
        await started;

        const write = supervisor.forward('files.write', {
            sessionId: 'session-1',
            path: '/project/source.txt',
            content: 'saved',
        });
        await Promise.resolve();
        const sent = child.postMessage.mock.calls[0][0] as { id: string };
        let settled = false;
        void write.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );

        await vi.advanceTimersByTimeAsync(20_000);
        expect(settled).toBe(false);

        child.emit('message', {
            id: sent.id,
            ok: false,
            error: { code: 'TIMEOUT', message: 'File operation timed out before it could start' },
        });
        await expect(write).rejects.toMatchObject({ code: 'TIMEOUT' });
    });

    it('retries a synchronous Runtime fork failure without abandoning startup', async () => {
        vi.useFakeTimers();
        electronMock.fork.mockImplementationOnce(() => {
            throw new Error('fork failed');
        });
        const supervisor = new RuntimeSupervisor(
            '/runtime',
            '/user-data',
            '/logs',
            fakeLogger() as unknown as StructuredLogger,
        );
        const started = supervisor.start();

        await vi.advanceTimersByTimeAsync(250);
        electronMock.children[0].emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 1 },
        });

        await expect(started).resolves.toBeUndefined();
        expect(electronMock.fork).toHaveBeenCalledTimes(2);
    });

    it('does not allow a late Renderer request to restart a shut down Runtime', async () => {
        const supervisor = new RuntimeSupervisor(
            '/runtime',
            '/user-data',
            '/logs',
            fakeLogger() as unknown as StructuredLogger,
        );
        const started = supervisor.start();
        const child = electronMock.children[0];
        child.emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
        await started;

        const shutdown = supervisor.shutdown();
        await Promise.resolve();
        await Promise.resolve();
        const request = child.postMessage.mock.calls[0][0] as { id: string };
        child.emit('message', { id: request.id, ok: true, result: null });
        await shutdown;

        await expect(supervisor.request('app.bootstrap')).rejects.toThrow('stopped');
        expect(electronMock.fork).toHaveBeenCalledTimes(1);
    });

    it('fails closed when a Runtime repeatedly becomes ready and then crashes immediately', async () => {
        vi.useFakeTimers();
        const supervisor = new RuntimeSupervisor(
            '/runtime',
            '/user-data',
            '/logs',
            fakeLogger() as unknown as StructuredLogger,
        );
        const statuses: string[] = [];
        supervisor.on('event', (event: { event: string; payload?: { status?: string } }) => {
            if (event.event === 'runtime.status' && event.payload?.status)
                statuses.push(event.payload.status);
        });
        const started = supervisor.start();
        electronMock.children[0].emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
        await started;

        for (let index = 0; index < 3; index += 1) {
            electronMock.children[index].emit('exit', 1);
            await vi.advanceTimersByTimeAsync(250 * 2 ** index);
            electronMock.children[index + 1].emit('message', {
                event: 'runtime.status',
                payload: { status: 'ready', restartCount: index + 1 },
            });
        }
        electronMock.children[3].emit('exit', 1);
        await vi.advanceTimersByTimeAsync(2_000);

        expect(electronMock.fork).toHaveBeenCalledTimes(4);
        expect(statuses.at(-1)).toBe('failed');
    });

    it('logs Runtime stdout/stderr as structured records instead of dropping them', async () => {
        const logger = fakeLogger();
        const supervisor = new RuntimeSupervisor(
            '/runtime',
            '/user-data',
            '/logs',
            logger as unknown as StructuredLogger,
        );
        const started = supervisor.start();
        const child = electronMock.children[0];
        child.emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
        await started;

        child.stdout.emit('data', Buffer.from('runtime booted\n'));
        child.stderr.emit('data', Buffer.from('native module warning\n'));

        expect(logger.write).toHaveBeenCalledWith(
            'info',
            'runtime.stdio',
            expect.objectContaining({ fields: { stream: 'stdout', line: 'runtime booted' } }),
        );
        expect(logger.write).toHaveBeenCalledWith(
            'warn',
            'runtime.stdio',
            expect.objectContaining({
                fields: { stream: 'stderr', line: 'native module warning' },
            }),
        );
    });

    it('caps an unterminated stdout line so a runaway process cannot grow the buffer unbounded', async () => {
        const logger = fakeLogger();
        const supervisor = new RuntimeSupervisor(
            '/runtime',
            '/user-data',
            '/logs',
            logger as unknown as StructuredLogger,
        );
        const started = supervisor.start();
        const child = electronMock.children[0];
        child.emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
        await started;

        child.stdout.emit('data', Buffer.from('a'.repeat(5_000)));

        const call = logger.write.mock.calls.find(([, event]) => event === 'runtime.stdio') as
            [string, string, { fields: { line: string } }] | undefined;
        expect(call).toBeDefined();
        expect(call?.[2].fields.line.length).toBeLessThan(5_000);
        expect(call?.[2].fields.line.endsWith('[truncated]')).toBe(true);
    });

    it('rejects malformed Runtime results at the utility-process boundary', async () => {
        const logger = fakeLogger();
        const supervisor = new RuntimeSupervisor(
            '/runtime',
            '/user-data',
            '/logs',
            logger as unknown as StructuredLogger,
        );
        const started = supervisor.start();
        const child = electronMock.children[0];
        child.emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
        await started;

        const request = supervisor.request('app.health');
        await Promise.resolve();
        const sent = child.postMessage.mock.calls[0][0] as { id: string };
        child.emit('message', { id: sent.id, ok: true, result: { ready: true } });

        await expect(request).rejects.toMatchObject({
            code: 'INTERNAL',
            message: 'Invalid result returned for app.health',
        });
        expect(logger.write).toHaveBeenCalledWith('error', 'runtime.result_invalid', {
            fields: { method: 'app.health', code: 'INTERNAL' },
        });
    });

    it('drops malformed Runtime events without exposing their payload', async () => {
        const logger = fakeLogger();
        const supervisor = new RuntimeSupervisor(
            '/runtime',
            '/user-data',
            '/logs',
            logger as unknown as StructuredLogger,
        );
        const started = supervisor.start();
        const child = electronMock.children[0];
        child.emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
        await started;
        const listener = vi.fn();
        supervisor.on('event', listener);

        child.emit('message', {
            event: 'terminal.output',
            payload: { data: 'secret output without a terminal id' },
        });

        expect(listener).not.toHaveBeenCalled();
        expect(logger.write).toHaveBeenCalledWith('error', 'runtime.message_invalid', {
            fields: { correlatedRequest: false },
        });
    });
});
