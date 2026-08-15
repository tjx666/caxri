import { describe, expect, it } from 'vitest';

import { PLATFORM_NEUTRAL_CI_COMMANDS } from '../platform-neutral-gates';
import {
    createEmptyReviewGate,
    createReviewPolicy,
    overrideReviewPolicy,
    recordReviewDecision,
} from '../review-gate';

function reviewing(policy: 'full-once' | 'quick' | 'light' = 'full-once') {
    return {
        phase: 'deep_review',
        reviewGate: createEmptyReviewGate(),
        reviewPolicy: createReviewPolicy(policy, 'test policy', '2026-08-12T00:00:00.000Z'),
        validations: PLATFORM_NEUTRAL_CI_COMMANDS.map((command) => ({
            command,
            headSha: 'baseline-head',
            kind: 'gates',
            result: 'passed',
        })),
    };
}

function fullBaseline(state: ReturnType<typeof reviewing>, shouldFreeze = false) {
    return recordReviewDecision(
        state,
        {
            freeze: shouldFreeze,
            headSha: 'baseline-head',
            mode: 'full',
            p0: 0,
            p1: 0,
            reviewedRange: 'origin/main...baseline-head',
            scope: 'Goal range',
        },
        '2026-08-12T00:01:00.000Z',
    );
}

describe('Go review gate', () => {
    it('allows exactly one full aggregate baseline', () => {
        const state = reviewing();
        fullBaseline(state);

        expect(() =>
            recordReviewDecision(state, {
                baselineHeadSha: 'baseline-head',
                baselineReviewId: 'review-001',
                freeze: true,
                headSha: 'replacement-head',
                mode: 'full',
                p0: 0,
                p1: 0,
                parentReviewId: 'review-001',
                reviewedRange: 'baseline-head..replacement-head',
                scope: 'Repeated Goal review',
            }),
        ).toThrow('exactly one full deep review baseline');
        expect(state.reviewGate.rounds.filter(({ mode }) => mode === 'full')).toHaveLength(1);
    });

    it('rejects full review before the exact-head canonical gate is complete', () => {
        const state = reviewing();
        state.validations.pop();
        expect(() => fullBaseline(state)).toThrow('canonical platform-neutral gate receipts');
    });

    it('requires exact baseline, parent, and range for every light delta', () => {
        const state = reviewing();
        fullBaseline(state);

        recordReviewDecision(state, {
            baselineHeadSha: 'baseline-head',
            baselineReviewId: 'review-001',
            freeze: false,
            headSha: 'repair-1',
            mode: 'light',
            p0: 0,
            p1: 1,
            parentReviewId: 'review-001',
            reviewedRange: 'baseline-head..repair-1',
            scope: 'P1 repair delta',
        });
        recordReviewDecision(state, {
            baselineHeadSha: 'baseline-head',
            baselineReviewId: 'review-001',
            freeze: true,
            headSha: 'repair-2',
            mode: 'light',
            p0: 0,
            p1: 0,
            parentReviewId: 'review-002',
            reviewedRange: 'repair-1..repair-2',
            scope: 'Targeted recheck delta',
        });

        expect(state.reviewGate).toMatchObject({
            baselineReviewId: 'review-001',
            frozenHeadSha: 'repair-2',
        });
        expect(state.reviewGate.rounds.at(-1)).toMatchObject({
            baselineHeadSha: 'baseline-head',
            baselineReviewId: 'review-001',
            parentReviewId: 'review-002',
            reviewedRange: 'repair-1..repair-2',
        });
    });

    it('fails closed when light review lineage is missing or stale', () => {
        const state = reviewing();
        fullBaseline(state);

        expect(() =>
            recordReviewDecision(state, {
                freeze: true,
                headSha: 'repair',
                mode: 'light',
                p0: 0,
                p1: 0,
                reviewedRange: 'baseline-head..repair',
                scope: 'Unbound delta',
            }),
        ).toThrow('exact baseline and parent review lineage');

        expect(() =>
            recordReviewDecision(state, {
                baselineHeadSha: 'baseline-head',
                baselineReviewId: 'review-001',
                freeze: true,
                headSha: 'repair',
                mode: 'light',
                p0: 0,
                p1: 0,
                parentReviewId: 'review-001',
                reviewedRange: 'origin/main...repair',
                scope: 'Wrong range',
            }),
        ).toThrow('Light delta review range must be baseline-head..repair');
    });

    it.each([
        ['quick', 'quick'],
        ['light', 'light'],
    ] as const)('uses the frozen %s policy for its aggregate baseline', (policy, mode) => {
        const state = reviewing(policy);
        recordReviewDecision(state, {
            freeze: true,
            headSha: `${mode}-head`,
            mode,
            p0: 0,
            p1: 0,
            reviewedRange: `origin/main...${mode}-head`,
            scope: `${mode} aggregate review`,
        });

        expect(state.reviewGate.frozenHeadSha).toBe(`${mode}-head`);
    });

    it('freezes policy before review starts and rejects later overrides', () => {
        const state = reviewing();
        overrideReviewPolicy(state, 'quick', 'Explicit user override');
        expect(state.reviewPolicy).toMatchObject({
            mode: 'quick',
            source: 'Explicit user override',
        });

        recordReviewDecision(state, {
            freeze: true,
            headSha: 'quick-head',
            mode: 'quick',
            p0: 0,
            p1: 0,
            reviewedRange: 'origin/main...quick-head',
            scope: 'Quick aggregate review',
        });
        expect(() => overrideReviewPolicy(state, 'light', 'Late override')).toThrow(
            'cannot change after the aggregate review baseline starts',
        );
    });

    it('rejects a frozen head with product P0/P1 findings and reviews outside review phases', () => {
        const state = reviewing();
        expect(() =>
            recordReviewDecision(state, {
                freeze: true,
                headSha: 'blocked-head',
                mode: 'full',
                p0: 0,
                p1: 1,
                reviewedRange: 'origin/main...blocked-head',
                scope: 'Goal range',
            }),
        ).toThrow('Cannot freeze a head with product P0 or P1 findings');

        state.phase = 'issue_execution';
        expect(() => fullBaseline(state)).toThrow('only during deep review or delivery');
    });
});
