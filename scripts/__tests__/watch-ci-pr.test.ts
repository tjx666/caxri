import { describe, expect, it, vi } from 'vitest';

import { prStartupStep, resolvePrRuns } from '../watch-ci-pr';

describe('prStartupStep', () => {
    it('waits until the same runs are seen on two polls, then watches them all', () => {
        const base = { mergeableState: 'clean', waitedMs: 0 };
        expect(prStartupStep({ ...base, previousRunIds: undefined, runIds: ['1'] })).toEqual({
            kind: 'wait',
        });
        expect(prStartupStep({ ...base, previousRunIds: ['1'], runIds: ['1', '2'] })).toEqual({
            kind: 'wait',
        });
        expect(prStartupStep({ ...base, previousRunIds: ['2', '1'], runIds: ['1', '2'] })).toEqual({
            kind: 'watch',
            runIds: ['1', '2'],
        });
    });

    it('reports a conflict when a head without runs cannot merge into its base', () => {
        expect(
            prStartupStep({ mergeableState: 'dirty', previousRunIds: [], runIds: [], waitedMs: 0 }),
        ).toEqual({ kind: 'conflict' });
    });

    it('keeps waiting for runs on a mergeable head and gives up after ten minutes', () => {
        const noRuns = { mergeableState: 'unknown', previousRunIds: [], runIds: [] };
        expect(prStartupStep({ ...noRuns, waitedMs: 30_000 })).toEqual({ kind: 'wait' });
        expect(prStartupStep({ ...noRuns, waitedMs: 600_000 })).toEqual({ kind: 'timeout' });
    });
});

describe('resolvePrRuns', () => {
    const settled = { headSha: 'abc', mergeableState: 'clean', runIds: ['7'] };
    const wait = async () => {};

    it('retries a dropped lookup instead of ending the watcher', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const readHead = vi
            .fn()
            .mockRejectedValueOnce(new Error('EOF'))
            .mockResolvedValueOnce(settled)
            .mockRejectedValueOnce(new Error('EOF'))
            .mockResolvedValueOnce(settled);

        await expect(resolvePrRuns('1', undefined, { readHead, wait })).resolves.toEqual(['7']);
        expect(readHead).toHaveBeenCalledTimes(4);
    });

    it('gives up after five consecutive failed lookups', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const readHead = vi.fn().mockRejectedValue(new Error('EOF'));

        await expect(resolvePrRuns('1', undefined, { readHead, wait })).rejects.toThrow('EOF');
        expect(readHead).toHaveBeenCalledTimes(5);
    });
});
