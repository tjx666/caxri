import { describe, expect, it } from 'vitest';

import { probeWorkerRoundTrip } from './worker-round-trip';

interface FakePaths {
    /**
     * Whether the Worker's own port (delivered thread-to-thread inside the Renderer, without ever leaving the process)
     * carries its answer back to the page.
     */
    direct: 'error' | 'message' | 'messageerror' | 'silence';
    /**
     * Whether the second answer, the one that leaves the Renderer and returns brokered by the browser process, arrives
     * at all.
     */
    broadcast: 'message' | 'silence';
    broadcastDelayed?: boolean;
}

/**
 * Stands in for a real `Worker` together with the `BroadcastChannel` it answers on. Driving the two return paths
 * independently is the whole point of the fake: telling them apart is the only thing the probe exists to do.
 */
function fakeWorker(paths: FakePaths) {
    const workerListeners = new Map<string, (event: unknown) => void>();
    const channelListeners = new Map<string, (event: unknown) => void>();
    let isTerminated = false;
    let isChannelClosed = false;
    const answerOnBroadcast = () => {
        if (paths.broadcast === 'silence') return;
        const deliver = () => channelListeners.get('message')?.({});
        if (paths.broadcastDelayed) setTimeout(deliver, 0);
        else queueMicrotask(deliver);
    };
    return {
        get terminated() {
            return isTerminated;
        },
        get channelClosed() {
            return isChannelClosed;
        },
        createBroadcastChannel: () =>
            ({
                addEventListener: (type: string, listener: (event: unknown) => void) => {
                    channelListeners.set(type, listener);
                },
                close: () => {
                    isChannelClosed = true;
                },
            }) as unknown as BroadcastChannel,
        worker: {
            addEventListener: (type: string, listener: (event: unknown) => void) => {
                workerListeners.set(type, listener);
            },
            postMessage: () => {
                answerOnBroadcast();
                if (paths.direct === 'silence') return;
                queueMicrotask(() => workerListeners.get(paths.direct)?.({}));
            },
            terminate: () => {
                isTerminated = true;
            },
        } as unknown as Worker,
    };
}

describe('Worker round-trip probe', () => {
    it('reports both paths replying, with a duration, and releases what it created', async () => {
        const fake = fakeWorker({ direct: 'message', broadcast: 'message' });
        let clock = 1_000;

        const result = await probeWorkerRoundTrip({
            createWorker: () => fake.worker,
            createBroadcastChannel: fake.createBroadcastChannel,
            now: () => (clock += 5),
        });

        expect(result).toEqual({ outcome: 'ok', durationMs: 5, broadcast: 'ok' });
        expect(fake.terminated).toBe(true);
        expect(fake.channelClosed).toBe(true);
    });

    it('waits for the slower path instead of calling it silent', async () => {
        const fake = fakeWorker({
            direct: 'message',
            broadcast: 'message',
            broadcastDelayed: true,
        });

        const result = await probeWorkerRoundTrip({
            createWorker: () => fake.worker,
            createBroadcastChannel: fake.createBroadcastChannel,
            timeoutMs: 200,
        });

        expect(result.broadcast).toBe('ok');
    });

    it('separates a lost Renderer-internal return path from a Worker that never ran', async () => {
        const lostReturnPath = fakeWorker({ direct: 'silence', broadcast: 'message' });
        const neverRan = fakeWorker({ direct: 'silence', broadcast: 'silence' });

        // The shape observed in issue #962: the Worker ran and answered, and only the reply into this page vanished.
        expect(
            await probeWorkerRoundTrip({
                createWorker: () => lostReturnPath.worker,
                createBroadcastChannel: lostReturnPath.createBroadcastChannel,
                timeoutMs: 5,
            }),
        ).toEqual({ outcome: 'no-reply', durationMs: null, broadcast: 'ok' });
        expect(
            await probeWorkerRoundTrip({
                createWorker: () => neverRan.worker,
                createBroadcastChannel: neverRan.createBroadcastChannel,
                timeoutMs: 5,
            }),
        ).toEqual({ outcome: 'no-reply', durationMs: null, broadcast: 'no-reply' });
    });

    it.each(['error', 'messageerror'] as const)(
        'separates a failing Worker from a silent one for %s',
        async (direct) => {
            const fake = fakeWorker({ direct, broadcast: 'silence' });

            const result = await probeWorkerRoundTrip({
                createWorker: () => fake.worker,
                createBroadcastChannel: fake.createBroadcastChannel,
                timeoutMs: 5,
            });

            expect(result).toEqual({
                outcome: 'worker-error',
                durationMs: null,
                broadcast: 'no-reply',
            });
        },
    );

    it('reports a construction failure instead of throwing', async () => {
        const result = await probeWorkerRoundTrip({
            createWorker: () => {
                throw new Error('blocked');
            },
        });

        expect(result).toEqual({
            outcome: 'construct-failed',
            durationMs: null,
            broadcast: 'skipped',
        });
    });

    it('still reports the direct path when this Renderer has no BroadcastChannel', async () => {
        const fake = fakeWorker({ direct: 'message', broadcast: 'silence' });

        const result = await probeWorkerRoundTrip({
            createWorker: () => fake.worker,
            createBroadcastChannel: () => {
                throw new Error('unavailable');
            },
            now: () => 7,
        });

        expect(result).toEqual({ outcome: 'ok', durationMs: 0, broadcast: 'unsupported' });
    });
});
