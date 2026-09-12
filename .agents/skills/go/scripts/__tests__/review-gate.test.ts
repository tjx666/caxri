import { describe, expect, it } from 'vitest';

import { PLATFORM_NEUTRAL_CI_COMMANDS } from '../platform-neutral-gates';
import {
    applyLatestReviewHeadReconciliation,
    createEmptyReviewGate,
    createReviewPolicy,
    overrideReviewPolicy,
    planLatestReviewHeadReconciliation,
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
            startedAt: '2026-08-12T00:00:30.000Z',
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

function reconciliationState() {
    const state = reviewing();
    fullBaseline(state);
    recordReviewDecision(
        state,
        {
            baselineHeadSha: 'baseline-head',
            baselineReviewId: 'review-001',
            freeze: true,
            headSha: 'missing-typed-head',
            mode: 'light',
            p0: 0,
            p1: 0,
            parentReviewId: 'review-001',
            reviewedRange: 'baseline-head..missing-typed-head',
            scope: 'Reviewed repair delta',
        },
        '2026-08-12T00:02:00.000Z',
    );
    return Object.assign(state, {
        acceptance: {
            acceptedHeadSha: null,
            id: null,
            publication: { history: [], orphanedStandalones: [], pendingAttempt: null },
            round: 0,
            status: 'not_started',
            url: null,
            waivedHeadSha: null,
            waiverReason: null,
        },
        ciFallback: { status: 'not_requested' },
        events: [
            {
                at: '2026-08-12T00:02:00.000Z',
                detail: 'review-002 light baseline-head..missing-typed-head',
                type: 'review',
            },
        ],
        finalization: null,
        handoffReport: null,
        mutationLease: null as { holderId: string; kind: string } | null,
        pullRequest: { headSha: 'published-parent' },
        resourceCleanup: null,
    });
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

    it('corrects only the latest review head and range while preserving its adjudication', () => {
        const state = reconciliationState();
        const original = structuredClone(state.reviewGate.rounds.at(-1)!);
        const reconciliation = planLatestReviewHeadReconciliation(state, {
            actualHeadSha: 'actual-head',
            reason: 'The typed full SHA did not resolve.',
            reviewId: 'review-002',
        });

        applyLatestReviewHeadReconciliation(state, reconciliation);

        expect(reconciliation.original).toEqual(original);
        expect(state.reviewGate.rounds).toHaveLength(2);
        expect(state.reviewGate.rounds.at(-1)).toEqual({
            ...original,
            headSha: 'actual-head',
            reviewedRange: 'baseline-head..actual-head',
        });
        expect(state.reviewGate.frozenHeadSha).toBe('actual-head');
    });

    it('rejects review reconciliation after downstream evidence consumption', () => {
        const state = reconciliationState();
        state.validations.push({
            command: 'bun run test',
            headSha: 'actual-head',
            kind: 'gates',
            result: 'passed',
            startedAt: '2026-08-12T00:03:00.000Z',
        });

        expect(() =>
            planLatestReviewHeadReconciliation(state, {
                actualHeadSha: 'actual-head',
                reason: 'The typed full SHA did not resolve.',
                reviewId: 'review-002',
            }),
        ).toThrow('consumed by later evidence');

        const published = reconciliationState();
        published.events.push({
            at: '2026-08-12T00:03:00.000Z',
            detail: 'PR 717 -> checks_pending',
            type: 'pull_request',
        });
        expect(() =>
            planLatestReviewHeadReconciliation(published, {
                actualHeadSha: 'actual-head',
                reason: 'The typed full SHA did not resolve.',
                reviewId: 'review-002',
            }),
        ).toThrow('consumed by later evidence');
    });

    it('rejects review reconciliation with active mutation or broken lineage', () => {
        const leased = reconciliationState();
        leased.mutationLease = { holderId: 'repair', kind: 'repair' };
        expect(() =>
            planLatestReviewHeadReconciliation(leased, {
                actualHeadSha: 'actual-head',
                reason: 'The typed full SHA did not resolve.',
                reviewId: 'review-002',
            }),
        ).toThrow('no active mutation lease');

        const broken = reconciliationState();
        broken.reviewGate.rounds.at(-1)!.reviewedRange = 'forged-range';
        expect(() =>
            planLatestReviewHeadReconciliation(broken, {
                actualHeadSha: 'actual-head',
                reason: 'The typed full SHA did not resolve.',
                reviewId: 'review-002',
            }),
        ).toThrow('intact review lineage');
    });
});
