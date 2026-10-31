import { describe, expect, it, vi } from 'vitest';

import type { PrRun } from '../watch-ci-pr';
import {
    didPrRunsSucceed,
    newerSameWorkflowRun,
    prStartupStep,
    resolvePrRuns,
} from '../watch-ci-pr';

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
    const run7: PrRun = { event: 'pull_request', id: '7', name: 'CI' };
    const settled = { headSha: 'abc', mergeableState: 'clean', runs: [run7] };
    const wait = async () => {};

    it('retries a dropped lookup instead of ending the watcher', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const readHead = vi
            .fn()
            .mockRejectedValueOnce(new Error('EOF'))
            .mockResolvedValueOnce(settled)
            .mockRejectedValueOnce(new Error('EOF'))
            .mockResolvedValueOnce(settled);

        await expect(resolvePrRuns('1', undefined, { readHead, wait })).resolves.toEqual({
            headSha: 'abc',
            runs: [run7],
        });
        expect(readHead).toHaveBeenCalledTimes(4);
    });

    it('gives up after five consecutive failed lookups', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const readHead = vi.fn().mockRejectedValue(new Error('EOF'));

        await expect(resolvePrRuns('1', undefined, { readHead, wait })).rejects.toThrow('EOF');
        expect(readHead).toHaveBeenCalledTimes(5);
    });
});

describe('didPrRunsSucceed', () => {
    const run = (id: string, name: string, event = 'pull_request'): PrRun => ({ event, id, name });
    // PR #3237: a push started Guards 10 and CI 11, marking the draft ready started Guards 20 and CI 21 on the same
    // head, and concurrency cancelled 10 and 11.
    const firstGuards = run('10', 'Guards');
    const firstCi = run('11', 'CI');
    const readyGuards = run('20', 'Guards');
    const readyCi = run('21', 'CI');
    const headRuns = [readyGuards, readyCi, firstGuards, firstCi];
    const wait = async () => {};

    function github(conclusions: Record<string, string>, listed: PrRun[] = headRuns) {
        return {
            isRunGood: vi.fn((runId: string) => Promise.resolve(conclusions[runId] === 'success')),
            listRuns: vi.fn(() => Promise.resolve(listed)),
            readConclusion: vi.fn((runId: string) => Promise.resolve(conclusions[runId] ?? '')),
        };
    }

    it('judges runs cancelled by a newer run of their workflow on the same head by that run', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const { isRunGood, listRuns, readConclusion } = github({
            '10': 'cancelled',
            '11': 'cancelled',
            '20': 'success',
            '21': 'success',
        });

        await expect(
            didPrRunsSucceed('abc', headRuns, isRunGood, undefined, {
                listRuns,
                readConclusion,
                wait,
            }),
        ).resolves.toBe(true);
        // Each run is watched once even though the cancelled runs resolve to the already watched replacements.
        expect(isRunGood).toHaveBeenCalledTimes(4);
    });

    it('fails when the replacement fails', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const { isRunGood, listRuns, readConclusion } = github({
            '10': 'cancelled',
            '11': 'cancelled',
            '20': 'success',
            '21': 'failure',
        });

        await expect(
            didPrRunsSucceed('abc', headRuns, isRunGood, undefined, {
                listRuns,
                readConclusion,
                wait,
            }),
        ).resolves.toBe(false);
    });

    it('fails a cancelled run that no newer run of its workflow replaced', async () => {
        const { isRunGood, listRuns, readConclusion } = github(
            { '10': 'success', '11': 'cancelled' },
            [firstGuards, firstCi],
        );

        await expect(
            didPrRunsSucceed('abc', [firstGuards, firstCi], isRunGood, undefined, {
                listRuns,
                readConclusion,
                wait,
            }),
        ).resolves.toBe(false);
        expect(listRuns).toHaveBeenCalledTimes(4);
    });

    it('follows a replacement that only appears after the watched runs were resolved', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const { isRunGood, readConclusion } = github({ '11': 'cancelled', '21': 'success' });
        const listRuns = vi
            .fn()
            .mockResolvedValueOnce([firstCi])
            .mockResolvedValueOnce([readyCi, firstCi]);

        await expect(
            didPrRunsSucceed('abc', [firstCi], isRunGood, undefined, {
                listRuns,
                readConclusion,
                wait,
            }),
        ).resolves.toBe(true);
        expect(isRunGood).toHaveBeenCalledWith('21');
    });

    it('does not count a failed run as replaced', async () => {
        const { isRunGood, listRuns, readConclusion } = github({
            '11': 'failure',
            '21': 'success',
        });

        await expect(
            didPrRunsSucceed('abc', [firstCi], isRunGood, undefined, {
                listRuns,
                readConclusion,
                wait,
            }),
        ).resolves.toBe(false);
        expect(listRuns).not.toHaveBeenCalled();
    });
});

describe('newerSameWorkflowRun', () => {
    it('picks the newest later run of the same workflow and event', () => {
        const ci = { event: 'pull_request', id: '11', name: 'CI' };
        expect(
            newerSameWorkflowRun(ci, [
                { event: 'pull_request', id: '9', name: 'CI' },
                { event: 'pull_request', id: '30', name: 'Guards' },
                { event: 'push', id: '40', name: 'CI' },
                { event: 'pull_request', id: '21', name: 'CI' },
                { event: 'pull_request', id: '25', name: 'CI' },
            ]),
        ).toEqual({ event: 'pull_request', id: '25', name: 'CI' });
        expect(newerSameWorkflowRun(ci, [ci])).toBeUndefined();
    });
});
