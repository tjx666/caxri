import { describe, expect, it } from 'vitest';

import { pollUntil } from './polling.ts';

/**
 * The window the timeout cases need for a second sample. `expect.poll` stops on wall-clock time, and a 20 ms window
 * ended inside the first sample when a loaded runner stalled it, leaving one attempt where the cases assert several.
 */
const TIMEOUT_AFTER_SAMPLES_MS = 250;

describe('pollUntil', () => {
    it('retries explicitly classified callback errors until a matching value is available', async () => {
        let attempts = 0;
        const transient = new Error('transient read');

        const value = await pollUntil(
            () => {
                attempts += 1;
                if (attempts < 3) throw transient;
                return 42;
            },
            (candidate) => candidate === 42,
            {
                intervals: [1],
                isRetryableError: (error) => error === transient,
                timeout: 100,
            },
        );

        expect(value).toBe(42);
        expect(attempts).toBe(3);
    });

    it('propagates an unclassified callback error on the first attempt', async () => {
        const failure = new Error('permission denied');
        let attempts = 0;

        await expect(
            pollUntil(
                () => {
                    attempts += 1;
                    throw failure;
                },
                () => true,
                { intervals: [1], timeout: 100 },
            ),
        ).rejects.toBe(failure);
        expect(attempts).toBe(1);
    });

    it('propagates an unclassified error after a retryable error', async () => {
        const transient = new Error('transient read');
        const failure = new Error('page closed');
        let attempts = 0;

        await expect(
            pollUntil(
                () => {
                    attempts += 1;
                    throw attempts === 1 ? transient : failure;
                },
                () => true,
                {
                    intervals: [1],
                    isRetryableError: (error) => error === transient,
                    timeout: 100,
                },
            ),
        ).rejects.toBe(failure);
        expect(attempts).toBe(2);
    });

    it('treats null and undefined samples as pending', async () => {
        const samples: Array<null | string | undefined> = [null, undefined, 'ready'];

        const value = await pollUntil(
            () => samples.shift(),
            (candidate) => candidate === 'ready',
            { intervals: [1], timeout: 100 },
        );

        expect(value).toBe('ready');
    });

    it('includes the last callback error when polling times out', async () => {
        let attempts = 0;

        await expect(
            pollUntil(
                () => {
                    attempts += 1;
                    throw new Error(`still unavailable ${attempts}`);
                },
                () => true,
                { intervals: [1], isRetryableError: () => true, timeout: TIMEOUT_AFTER_SAMPLES_MS },
            ),
        ).rejects.toThrow(/Last callback error: still unavailable \d+/);
        expect(attempts).toBeGreaterThan(1);
    });

    it('keeps the last callback error when later samples are pending', async () => {
        let attempts = 0;

        await expect(
            pollUntil(
                () => {
                    attempts += 1;
                    if (attempts === 1) throw new Error('initial transient failure');
                    return null;
                },
                () => true,
                { intervals: [1], isRetryableError: () => true, timeout: TIMEOUT_AFTER_SAMPLES_MS },
            ),
        ).rejects.toThrow('Last callback error: initial transient failure');
        expect(attempts).toBeGreaterThan(1);
    });

    it('returns the matching value without rewriting it', async () => {
        const value: { status: string; width: number } = { status: 'ready', width: 120 };

        await expect(
            pollUntil(
                () => value,
                (candidate) => candidate.width > 0,
            ),
        ).resolves.toBe(value);
    });
});
