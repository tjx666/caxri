import { describe, expect, it } from 'vitest';

import {
    diffWorkerRecoveryReducer,
    initialDiffWorkerRecoveryState,
    MAX_AUTOMATIC_WORKER_RECOVERIES,
} from '../diff-worker-recovery';

describe('diffWorkerRecoveryReducer', () => {
    it('starts idle with no automatic attempts spent', () => {
        expect(initialDiffWorkerRecoveryState).toEqual({ attempts: 0, status: 'idle' });
    });

    it('recovers on the first stall a worker never replies to', () => {
        const state = diffWorkerRecoveryReducer(initialDiffWorkerRecoveryState, {
            type: 'stalled',
        });

        expect(state).toEqual({ attempts: 1, status: 'recovering' });
    });

    it('gives up once the automatic budget is spent, so a second stall reaches the user', () => {
        const recovering = diffWorkerRecoveryReducer(initialDiffWorkerRecoveryState, {
            type: 'stalled',
        });

        const exhausted = diffWorkerRecoveryReducer(recovering, { type: 'stalled' });

        expect(exhausted).toEqual({
            attempts: MAX_AUTOMATIC_WORKER_RECOVERIES,
            status: 'exhausted',
        });
    });

    it('clears back to idle once a comparison finally computes', () => {
        const recovering = diffWorkerRecoveryReducer(initialDiffWorkerRecoveryState, {
            type: 'stalled',
        });

        expect(diffWorkerRecoveryReducer(recovering, { type: 'computed' })).toEqual({
            attempts: 1,
            status: 'idle',
        });
    });

    it('resets the spent budget once the surface moves to a different comparison', () => {
        const exhausted = diffWorkerRecoveryReducer(
            diffWorkerRecoveryReducer(initialDiffWorkerRecoveryState, { type: 'stalled' }),
            { type: 'stalled' },
        );

        expect(diffWorkerRecoveryReducer(exhausted, { type: 'restarted' })).toEqual(
            initialDiffWorkerRecoveryState,
        );
    });

    it('keeps the same state object when nothing changes, so an effect dispatch cannot loop', () => {
        expect(
            diffWorkerRecoveryReducer(initialDiffWorkerRecoveryState, { type: 'computed' }),
        ).toBe(initialDiffWorkerRecoveryState);
        expect(
            diffWorkerRecoveryReducer(initialDiffWorkerRecoveryState, { type: 'restarted' }),
        ).toBe(initialDiffWorkerRecoveryState);
        const exhausted = diffWorkerRecoveryReducer(
            diffWorkerRecoveryReducer(initialDiffWorkerRecoveryState, { type: 'stalled' }),
            { type: 'stalled' },
        );
        expect(diffWorkerRecoveryReducer(exhausted, { type: 'stalled' })).toBe(exhausted);
    });
});
