import { describe, expect, it } from 'vitest';

import {
    failedPullRequestCheckNames,
    pullRequestMergeBlocker,
} from '../pull-request-merge-readiness';

describe('pullRequestMergeBlocker', () => {
    it.each([
        [{ state: 'success', mergeState: 'clean' }, undefined],
        // A failing check the user did not ignore already shows in the filtered rollup; GitHub's `unstable` adds nothing.
        [{ state: 'success', mergeState: 'unstable' }, undefined],
        [{ state: 'success' }, undefined],
        [{ state: 'failure', mergeState: 'conflicting' }, 'conflicting'],
        [{ state: 'failure', mergeState: 'clean' }, 'checks-failed'],
        [{ state: 'cancelled', mergeState: 'clean' }, 'checks-failed'],
        [{ state: 'queued', mergeState: 'clean' }, 'checks-running'],
        [{ state: 'pending', mergeState: 'blocked' }, 'checks-running'],
        [{ state: 'unknown', mergeState: 'clean' }, 'checks-running'],
        [{ state: 'neutral', mergeState: 'blocked' }, 'branch-protection'],
        [{ state: 'success', mergeState: 'behind' }, 'behind'],
        [{ state: 'success', mergeState: 'unknown' }, 'mergeability-unknown'],
    ] as const)('reads %o as %s', (pullRequest, blocker) => {
        expect(pullRequestMergeBlocker(pullRequest)).toBe(blocker);
    });
});

describe('failedPullRequestCheckNames', () => {
    it('lists failed and cancelled checks in rollup order', () => {
        expect(
            failedPullRequestCheckNames({
                checks: [
                    { name: 'lint', state: 'failure' },
                    { name: 'unit', state: 'success' },
                    { name: 'e2e', state: 'cancelled' },
                    { name: 'docs', state: 'pending' },
                ],
            }),
        ).toEqual(['lint', 'e2e']);
    });
});
