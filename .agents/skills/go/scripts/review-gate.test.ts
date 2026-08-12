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

    it('reserves deep-review targeted verification for repairs after the third full round', () => {
        const state = reviewing();
        for (const headSha of ['head-1', 'head-2']) {
            recordReviewDecision(state, {
                freeze: false,
                headSha,
                mode: 'full',
                p0: 0,
                p1: 1,
                scope: 'Goal range',
            });
        }

        expect(() =>
            recordReviewDecision(state, {
                freeze: true,
                headSha: 'premature-targeted',
                mode: 'targeted',
                p0: 0,
                p1: 0,
                scope: 'Premature targeted verification',
            }),
        ).toThrow('only after the third full review');
    });

    it('keeps one targeted repair available during delivery before the full-round ceiling', () => {
        const state = reviewing();
        recordReviewDecision(state, {
            freeze: true,
            headSha: 'product-head',
            mode: 'full',
            p0: 0,
            p1: 0,
            scope: 'Goal range',
        });
        state.phase = 'delivery';

        recordReviewDecision(state, {
            freeze: true,
            headSha: 'delivery-repair',
            mode: 'targeted',
            p0: 0,
            p1: 0,
            scope: 'CI repair',
        });
        expect(state.reviewGate.frozenHeadSha).toBe('delivery-repair');

        expect(() =>
            recordReviewDecision(state, {
                authorization: 'User approved another verification.',
                freeze: true,
                headSha: 'delivery-repair-2',
                mode: 'targeted',
                p0: 0,
                p1: 0,
                scope: 'Disallowed repeated delivery repair',
            }),
        ).toThrow('Only one targeted verification is allowed after each full review');
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

    it('requires explicit authorization for one final delivery-stage repair freeze', () => {
        const state = reviewing();
        const verification = (headSha: string, authorization?: string) =>
            recordReviewDecision(state, {
                authorization,
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
        verification('pre-delivery');
        expect(() => verification('extra-pre-delivery')).toThrow('one pre-delivery');

        state.phase = 'delivery';
        verification('delivery-1');
        verification('delivery-2');
        verification('delivery-3');
        expect(() => verification('delivery-4')).toThrow('requires explicit user authorization');
        verification('delivery-4', 'User approved one final delivery verification.');
        expect(() => verification('delivery-5')).toThrow('requires explicit user authorization');
        verification('delivery-5', 'User approved one systemic CI-parity verification.');
        expect(() => verification('delivery-6')).toThrow('requires explicit user authorization');
        verification('delivery-6', 'User approved one final hosted E2E fixture verification.');
        expect(() =>
            verification('delivery-7', 'User approved another delivery verification.'),
        ).toThrow('six delivery-stage');
        expect(
            state.reviewGate.rounds
                .filter(({ mode }) => mode === 'verification')
                .map(({ phase }) => phase),
        ).toEqual([
            'deep_review',
            'delivery',
            'delivery',
            'delivery',
            'delivery',
            'delivery',
            'delivery',
        ]);
    });

    it('conservatively charges unphased freezes to the current delivery budget', () => {
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
            headSha: 'legacy-pre-delivery',
            mode: 'verification',
            p0: 0,
            p1: 0,
            scope: 'Legacy verification-only delta',
        });
        state.phase = 'delivery';
        for (const headSha of ['legacy-delivery-1', 'legacy-delivery-2']) {
            recordReviewDecision(state, {
                freeze: true,
                headSha,
                mode: 'verification',
                p0: 0,
                p1: 0,
                scope: 'Legacy verification-only delta',
            });
        }
        for (const decision of state.reviewGate.rounds) Reflect.deleteProperty(decision, 'phase');

        expect(() =>
            recordReviewDecision(state, {
                freeze: true,
                headSha: 'next-delivery',
                mode: 'verification',
                p0: 0,
                p1: 0,
                scope: 'Conservatively blocked delivery verification',
            }),
        ).toThrow('requires explicit user authorization');
    });

    it('allows one explicitly authorized final targeted verification after the first finds P0/P1', () => {
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
            freeze: false,
            headSha: 'targeted-1',
            mode: 'targeted',
            p0: 0,
            p1: 1,
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
        ).toThrow('requires explicit user authorization');

        recordReviewDecision(state, {
            authorization: 'User approved one final targeted verification.',
            freeze: true,
            headSha: 'targeted-2',
            mode: 'targeted',
            p0: 0,
            p1: 0,
            scope: 'Authorized architecture repair',
        });
        expect(state.reviewGate.frozenHeadSha).toBe('targeted-2');
        expect(state.reviewGate.rounds.at(-1)?.authorization).toContain('User approved');

        expect(() =>
            recordReviewDecision(state, {
                authorization: 'User approved another verification.',
                freeze: true,
                headSha: 'targeted-3',
                mode: 'targeted',
                p0: 0,
                p1: 0,
                scope: 'Disallowed third targeted verification',
            }),
        ).toThrow('at most two targeted verifications');
    });

    it('rejects an extra targeted verification when the prior targeted decision was clean', () => {
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
            headSha: 'targeted-clean',
            mode: 'targeted',
            p0: 0,
            p1: 0,
            scope: 'Clean targeted verification',
        });

        expect(() =>
            recordReviewDecision(state, {
                authorization: 'User approved another verification.',
                freeze: true,
                headSha: 'targeted-extra',
                mode: 'targeted',
                p0: 0,
                p1: 0,
                scope: 'Unnecessary extra verification',
            }),
        ).toThrow('prior targeted verification found no product P0/P1');
    });
});
