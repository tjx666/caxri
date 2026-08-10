import { describe, expect, it } from 'vitest';

import { createEmptyReviewGate, recordReviewDecision } from './review-gate';

function reviewing() {
    return { phase: 'deep_review', reviewGate: createEmptyReviewGate() };
}

describe('Go review gate', () => {
    it('stops full deep review after three rounds', () => {
        const state = reviewing();

        recordReviewDecision(state, {
            freeze: false,
            headSha: 'head-1',
            mode: 'full',
            p0: 0,
            p1: 1,
            scope: 'Goal range',
        });
        recordReviewDecision(state, {
            freeze: false,
            headSha: 'head-2',
            mode: 'full',
            p0: 0,
            p1: 1,
            scope: 'Goal range',
        });
        recordReviewDecision(state, {
            freeze: false,
            headSha: 'head-3',
            mode: 'full',
            p0: 0,
            p1: 1,
            scope: 'Goal range',
        });

        expect(() =>
            recordReviewDecision(state, {
                freeze: false,
                headSha: 'head-4',
                mode: 'full',
                p0: 0,
                p1: 0,
                scope: 'Goal range',
            }),
        ).toThrow('Full deep review is limited to three rounds');
    });

    it('freezes only an exact head with no product P0 or P1 findings', () => {
        const state = reviewing();

        expect(() =>
            recordReviewDecision(state, {
                freeze: true,
                headSha: 'blocked-head',
                mode: 'full',
                p0: 0,
                p1: 1,
                scope: 'Goal range',
            }),
        ).toThrow('Cannot freeze a head with product P0 or P1 findings');

        recordReviewDecision(state, {
            freeze: true,
            headSha: 'clean-head',
            mode: 'full',
            p0: 0,
            p1: 0,
            scope: 'Workflow-only delta',
        });

        expect(state.reviewGate.frozenHeadSha).toBe('clean-head');
    });

    it('rejects targeted verification without a full review baseline', () => {
        const state = reviewing();

        expect(() =>
            recordReviewDecision(state, {
                freeze: true,
                headSha: 'targeted-head',
                mode: 'targeted',
                p0: 0,
                p1: 0,
                scope: 'Unreviewed change',
            }),
        ).toThrow('requires a prior full Goal-range review');
    });

    it('allows only one targeted verification after the third full review', () => {
        const state = reviewing();
        for (const headSha of ['head-1', 'head-2', 'head-3']) {
            recordReviewDecision(state, {
                freeze: false,
                headSha,
                mode: 'full',
                p0: 0,
                p1: 1,
                scope: 'Goal range',
            });
        }
        recordReviewDecision(state, {
            freeze: true,
            headSha: 'targeted-1',
            mode: 'targeted',
            p0: 0,
            p1: 0,
            scope: 'Round-three P1 repair',
        });

        expect(() =>
            recordReviewDecision(state, {
                freeze: true,
                headSha: 'targeted-2',
                mode: 'targeted',
                p0: 0,
                p1: 0,
                scope: 'Unexpected follow-up',
            }),
        ).toThrow('Only one targeted verification');
    });
});
