import { describe, expect, it } from 'vitest';

import { probeWorkerRoundTrip } from './worker-round-trip';

/**
 * Stands in for a real `Worker`: `reply` decides whether the Renderer ever hears back, which is the single distinction
 * the probe exists to make.
 */
function fakeWorker(reply: 'error' | 'message' | 'messageerror' | 'silence') {
    const listeners = new Map<string, (event: unknown) => void>();
    let isTerminated = false;
    return {
        get terminated() {
            return isTerminated;
        },
        worker: {
            addEventListener: (type: string, listener: (event: unknown) => void) => {
                listeners.set(type, listener);
            },
            postMessage: () => {
                if (reply === 'silence') return;
                queueMicrotask(() => listeners.get(reply === 'message' ? 'message' : reply)?.({}));
            },
            terminate: () => {
                isTerminated = true;
            },
        } as unknown as Worker,
    };
}

describe('Worker round-trip probe', () => {
    it('reports a reply with its duration and releases the Worker', async () => {
        const fake = fakeWorker('message');
        let clock = 1_000;

        const result = await probeWorkerRoundTrip({
            createWorker: () => fake.worker,
            now: () => (clock += 5),
        });

        expect(result).toEqual({ outcome: 'ok', durationMs: 5 });
        expect(fake.terminated).toBe(true);
    });

    it('reports no reply without a duration when the Worker stays silent', async () => {
        const fake = fakeWorker('silence');

        const result = await probeWorkerRoundTrip({
            createWorker: () => fake.worker,
            timeoutMs: 1,
        });

        expect(result).toEqual({ outcome: 'no-reply', durationMs: null });
        expect(fake.terminated).toBe(true);
    });

    it.each(['error', 'messageerror'] as const)(
        'separates a failing Worker from a silent one for %s',
        async (reply) => {
            const result = await probeWorkerRoundTrip({
                createWorker: () => fakeWorker(reply).worker,
                timeoutMs: 50,
            });

            expect(result).toEqual({ outcome: 'worker-error', durationMs: null });
        },
    );

    it('reports a construction failure instead of throwing', async () => {
        const result = await probeWorkerRoundTrip({
            createWorker: () => {
                throw new Error('blocked');
            },
        });

        expect(result).toEqual({ outcome: 'construct-failed', durationMs: null });
    });
});
