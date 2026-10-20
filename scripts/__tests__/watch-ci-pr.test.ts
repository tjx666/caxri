import { describe, expect, it } from 'vitest';

import { prStartupStep } from '../watch-ci-pr';

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
