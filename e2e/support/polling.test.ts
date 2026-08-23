import { describe, expect, it } from 'vitest';

import { pollUntil } from './polling.ts';

describe('pollUntil', () => {
    it('retries callback errors until a matching value is available', async () => {
        let attempts = 0;

        const value = await pollUntil(
            () => {
                attempts += 1;
                if (attempts < 3) throw new Error(`transient attempt ${attempts}`);
                return 42;
            },
            (candidate) => candidate === 42,
            { intervals: [1], timeout: 100 },
        );

        expect(value).toBe(42);
        expect(attempts).toBe(3);
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
                { intervals: [1], timeout: 20 },
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
                { intervals: [1], timeout: 20 },
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
