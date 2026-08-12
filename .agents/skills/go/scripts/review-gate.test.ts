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

    it('freezes a verification-only delta without consuming another product review', () => {
        const state = reviewing();
        recordReviewDecision(state, {
            freeze: false,
            headSha: 'product-head',
            mode: 'full',
            p0: 0,
            p1: 0,
            scope: 'Goal range',
        });
        recordReviewDecision(state, {
            freeze: true,
            headSha: 'verification-head',
            mode: 'verification',
            p0: 0,
            p1: 0,
            scope: 'E2E stabilization only',
        });

        expect(state.reviewGate.frozenHeadSha).toBe('verification-head');
        expect(state.reviewGate.rounds.filter(({ mode }) => mode === 'full')).toHaveLength(1);
    });

    it('bounds verification-only freezes and requires a full review baseline', () => {
        const state = reviewing();
        const verification = (headSha: string) =>
            recordReviewDecision(state, {
                freeze: true,
                headSha,
                mode: 'verification',
                p0: 0,
                p1: 0,
                scope: 'Verification-only delta',
            });

        expect(() => verification('unreviewed-head')).toThrow('requires a prior full');
        recordReviewDecision(state, {
            freeze: false,
            headSha: 'product-head',
            mode: 'full',
            p0: 0,
            p1: 0,
            scope: 'Goal range',
        });
        verification('verification-1');
        verification('verification-2');
        verification('verification-3');
        expect(() => verification('verification-4')).toThrow('at most three verification-only');

        recordReviewDecision(state, {
            freeze: true,
            headSha: 'verification-4',
            mode: 'verification',
            p0: 0,
            p1: 0,
            scope: 'Explicitly authorized verification-only delta',
            verificationCapAuthorization: 'User explicitly authorized one exception.',
        });
        expect(state.reviewGate.rounds.at(-1)).toMatchObject({
            headSha: 'verification-4',
            verificationCapAuthorization: 'User explicitly authorized one exception.',
        });
        expect(() =>
            recordReviewDecision(state, {
                freeze: true,
                headSha: 'verification-5',
                mode: 'verification',
                p0: 0,
                p1: 0,
                scope: 'Second exception',
                verificationCapAuthorization: 'User authorized another exception.',
            }),
        ).toThrow('only one explicitly authorized verification-cap exception');
    });

    it('rejects premature verification-cap authorization', () => {
        const state = reviewing();
        recordReviewDecision(state, {
            freeze: false,
            headSha: 'product-head',
            mode: 'full',
            p0: 0,
            p1: 0,
            scope: 'Goal range',
        });

        expect(() =>
            recordReviewDecision(state, {
                freeze: true,
                headSha: 'verification-1',
                mode: 'verification',
                p0: 0,
                p1: 0,
                scope: 'Verification-only delta',
                verificationCapAuthorization: 'Unneeded authorization.',
            }),
        ).toThrow('only after the default three-freeze limit');
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
