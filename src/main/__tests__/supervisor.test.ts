import { afterEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
    type Listener = (...args: unknown[]) => void;
    interface FakeChild {
        emit(event: string, ...args: unknown[]): void;
        kill: ReturnType<typeof vi.fn>;
        on(event: string, listener: Listener): FakeChild;
        postMessage: ReturnType<typeof vi.fn>;
    }

    const children: FakeChild[] = [];
    const fork = vi.fn(() => {
        const listeners = new Map<string, Listener[]>();
        const child: FakeChild = {
            emit(event, ...args) {
                for (const listener of listeners.get(event) ?? []) listener(...args);
            },
            kill: vi.fn(),
            on(event, listener) {
                listeners.set(event, [...(listeners.get(event) ?? []), listener]);
                return child;
            },
            postMessage: vi.fn(),
        };
        children.push(child);
        return child;
    });
    return { children, fork };
});

vi.mock('electron', () => ({ utilityProcess: { fork: electronMock.fork } }));

import { RuntimeSupervisor } from '../supervisor';

afterEach(() => {
    vi.useRealTimers();
    electronMock.children.length = 0;
    electronMock.fork.mockClear();
});

describe('RuntimeSupervisor', () => {
    it('settles the original startup promise when a restarted Runtime becomes ready', async () => {
        vi.useFakeTimers();
        const supervisor = new RuntimeSupervisor('/runtime', '/user-data', '/logs');
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
        const supervisor = new RuntimeSupervisor('/runtime', '/user-data', '/logs');
        const started = supervisor.start();
        const rejection = expect(started).rejects.toThrow('did not become ready');

        await vi.advanceTimersByTimeAsync(15_000);

        await rejection;
        expect(electronMock.children[0].kill).toHaveBeenCalledOnce();
    });

    it('retries a synchronous Runtime fork failure without abandoning startup', async () => {
        vi.useFakeTimers();
        electronMock.fork.mockImplementationOnce(() => {
            throw new Error('fork failed');
        });
        const supervisor = new RuntimeSupervisor('/runtime', '/user-data', '/logs');
        const started = supervisor.start();

        await vi.advanceTimersByTimeAsync(250);
        electronMock.children[0].emit('message', {
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 1 },
        });

        await expect(started).resolves.toBeUndefined();
        expect(electronMock.fork).toHaveBeenCalledTimes(2);
    });
});
