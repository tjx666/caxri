import type { MobilePullRequest } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    MobileConnectionClosedError,
    MobileGatewayRequestError,
    MobileGatewayTimeoutError,
} from '../../connection/mobile-gateway-errors';
import {
    isPullRequestMergeTransportError,
    pullRequestChecksSummary,
    pullRequestConfirmation,
    pullRequestMergeAction,
    pullRequestMergeErrorMessage,
    pullRequestMergeMethodNote,
    pullRequestReadiness,
    pullRequestTone,
    shouldShowPullRequestConfirmation,
} from '../pull-request-model';

const pr = (overrides: Partial<MobilePullRequest> = {}): MobilePullRequest => ({
    repositoryId: 'primary',
    number: 42,
    title: 'Delivery',
    url: 'https://github.com/owner/example/pull/42',
    lifecycle: 'open',
    checks: 'success',
    checkCount: 9,
    failedChecks: [],
    failedCheckCount: 0,
    headSha: 'a'.repeat(40),
    ...overrides,
});

describe('mobile pull request merge model', () => {
    it('reads a ready pull request as nothing blocking its merge', () => {
        expect(pullRequestMergeAction(pr())).toEqual({ kind: 'merge' });
        expect(pullRequestTone(pr())).toBe('success');
        expect(pullRequestReadiness(pr(), translate)).toBe('Ready to merge');
    });

    it('asks first for every blocker but a conflict, and names failed checks as an override', () => {
        expect(pullRequestMergeAction(pr({ mergeBlocker: 'checks-failed' }))).toEqual({
            kind: 'confirm',
            blocker: 'checks-failed',
            isOverride: true,
        });
        for (const blocker of [
            'checks-running',
            'branch-protection',
            'behind',
            'mergeability-unknown',
        ] as const)
            expect(pullRequestMergeAction(pr({ mergeBlocker: blocker }))).toMatchObject({
                kind: 'confirm',
                isOverride: false,
            });
        expect(pullRequestMergeAction(pr({ mergeBlocker: 'conflicting' }))).toEqual({
            kind: 'refused',
        });
    });

    it('offers no merge for a draft, an unreported head, or a finished pull request', () => {
        expect(pullRequestMergeAction(pr({ lifecycle: 'draft' }))).toEqual({ kind: 'draft' });
        expect(pullRequestMergeAction(pr({ headSha: undefined }))).toEqual({ kind: 'waiting' });
        expect(pullRequestMergeAction(pr({ lifecycle: 'merged' }))).toEqual({ kind: 'none' });
        expect(pullRequestMergeAction(pr({ lifecycle: 'closed' }))).toEqual({ kind: 'none' });
        expect(pullRequestTone(pr({ lifecycle: 'merged' }))).toBe('merged');
        expect(pullRequestReadiness(pr({ lifecycle: 'closed' }), translate)).toBe(
            'Closed without merging',
        );
    });

    it('colors a blocker by whether the user has something to fix', () => {
        expect(pullRequestTone(pr({ mergeBlocker: 'checks-failed' }))).toBe('danger');
        expect(pullRequestTone(pr({ mergeBlocker: 'behind' }))).toBe('warning');
        expect(pullRequestTone(pr({ mergeBlocker: 'checks-running' }))).toBe('neutral');
    });

    it('summarizes checks with a few failed names and a count of the rest', () => {
        const failing = pr({
            checks: 'failure',
            mergeBlocker: 'checks-failed',
            failedChecks: ['lint', 'e2e', 'docs'],
            failedCheckCount: 4,
        });
        expect(pullRequestChecksSummary(failing, translate)).toBe(
            '4 of 9 checks failed: lint, e2e, docs, and 1 more',
        );
        expect(pullRequestConfirmation(failing, 'checks-failed', translate)).toBe(
            '4 of 9 checks failed: lint, e2e, docs, and 1 more',
        );
        expect(pullRequestChecksSummary(pr(), translate)).toBe('9 checks passed');
        expect(pullRequestChecksSummary(pr({ checkCount: 1 }), translate)).toBe('1 check passed');
        expect(pullRequestChecksSummary(pr({ checks: 'pending' }), translate)).toBe(
            'Checks running',
        );
        expect(pullRequestChecksSummary(pr({ checks: 'failure' }), translate)).toBe(
            'Some checks did not pass',
        );
        expect(pullRequestChecksSummary(pr({ checkCount: 0 }), translate)).toBeUndefined();
    });

    it("explains a refused merge, keeping GitHub's own reason", () => {
        expect(
            pullRequestMergeErrorMessage(new MobileGatewayRequestError('CONFLICT', 'x'), translate),
        ).toBe('This pull request now has conflicts.');
        expect(
            pullRequestMergeErrorMessage(
                new MobileGatewayRequestError('NOT_FOUND', 'x'),
                translate,
            ),
        ).toBe('This pull request changed. Review it again before merging.');
        expect(
            pullRequestMergeErrorMessage(
                new MobileGatewayRequestError('GIT', 'Required status check "lint" is expected.'),
                translate,
            ),
        ).toBe('GitHub did not merge this pull request. Required status check "lint" is expected.');
    });

    it('names the method and target branch the merge will use, as Desktop does', () => {
        expect(
            pullRequestMergeMethodNote(
                pr({ mergeMethod: 'squash', baseBranch: 'main' }),
                translate,
            ),
        ).toBe('Squash and merge into main.');
        expect(pullRequestMergeMethodNote(pr({ mergeMethod: 'rebase' }), translate)).toBe(
            'Rebase and merge. This repository allows neither squash merging nor merge commits.',
        );
        expect(pullRequestMergeMethodNote(pr(), translate)).toBe(
            'Squash and merge when the repository allows it, otherwise a merge commit, then rebase.',
        );
    });

    it('does not claim GitHub refused a merge whose answer never arrived', () => {
        const lost = 'Lost connection before GitHub answered. Checking the pull request…';
        for (const error of [new MobileGatewayTimeoutError(), new MobileConnectionClosedError()]) {
            expect(isPullRequestMergeTransportError(error)).toBe(true);
            expect(pullRequestMergeErrorMessage(error, translate)).toBe(lost);
        }
        expect(isPullRequestMergeTransportError(new MobileGatewayRequestError('GIT', 'x'))).toBe(
            false,
        );
        expect(isPullRequestMergeTransportError(new Error('boom'))).toBe(false);
    });

    it('shows the confirmation only while the action is still confirmable', () => {
        expect(shouldShowPullRequestConfirmation(true, { kind: 'merge' })).toBe(true);
        expect(
            shouldShowPullRequestConfirmation(true, {
                kind: 'confirm',
                blocker: 'behind',
                isOverride: false,
            }),
        ).toBe(true);
        expect(shouldShowPullRequestConfirmation(false, { kind: 'merge' })).toBe(false);
        for (const kind of ['refused', 'draft', 'waiting', 'none'] as const)
            expect(shouldShowPullRequestConfirmation(true, { kind })).toBe(false);
    });
});
