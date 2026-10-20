import type { ProjectStatusRepository as ProjectStatusRepo } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { EMPTY_CHECK_ROLLUP_GRACE_MS, EmptyCheckRollupTracker } from '../empty-check-rollup';

type PullRequest = NonNullable<ProjectStatusRepo['pullRequest']>;

function openPullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
    return {
        checks: [],
        headSha: 'a'.repeat(40),
        hiddenCheckCount: 0,
        lifecycle: 'open',
        mergeBlocker: 'checks-running',
        mergeState: 'clean',
        number: 7,
        state: 'pending',
        title: 'Add notes',
        url: 'https://github.com/owner/example/pull/7',
        ...overrides,
    };
}

describe('EmptyCheckRollupTracker', () => {
    it('keeps a just-pushed head pending until the grace window passes, then settles it as neutral', () => {
        const tracker = new EmptyCheckRollupTracker();
        expect(tracker.settle(openPullRequest(), 0)?.state).toBe('pending');
        expect(tracker.settle(openPullRequest(), EMPTY_CHECK_ROLLUP_GRACE_MS - 1)?.state).toBe(
            'pending',
        );

        const settled = tracker.settle(openPullRequest(), EMPTY_CHECK_ROLLUP_GRACE_MS);
        expect(settled?.state).toBe('neutral');
        expect(settled?.mergeBlocker).toBeUndefined();
    });

    it('keeps a merge blocker that does not come from the checks', () => {
        const tracker = new EmptyCheckRollupTracker();
        tracker.settle(openPullRequest({ mergeState: 'conflicting' }), 0);
        const settled = tracker.settle(
            openPullRequest({ mergeState: 'conflicting' }),
            EMPTY_CHECK_ROLLUP_GRACE_MS,
        );
        expect(settled).toMatchObject({ state: 'neutral', mergeBlocker: 'conflicting' });
    });

    it('restarts the window for a new head commit', () => {
        const tracker = new EmptyCheckRollupTracker();
        tracker.settle(openPullRequest(), 0);
        const pushed = openPullRequest({ headSha: 'b'.repeat(40) });
        expect(tracker.settle(pushed, EMPTY_CHECK_ROLLUP_GRACE_MS)?.state).toBe('pending');
    });

    it('forgets a head once checks register, so a later empty read starts a new window', () => {
        const tracker = new EmptyCheckRollupTracker();
        tracker.settle(openPullRequest(), 0);
        tracker.settle(
            openPullRequest({
                checks: [{ name: 'test', state: 'pending' }],
                state: 'pending',
            }),
            1000,
        );
        expect(tracker.settle(openPullRequest(), EMPTY_CHECK_ROLLUP_GRACE_MS)?.state).toBe(
            'pending',
        );
    });

    it('leaves pull requests with checks, hidden checks, or no head untouched', () => {
        const tracker = new EmptyCheckRollupTracker();
        for (const pullRequest of [
            openPullRequest({ hiddenCheckCount: 1 }),
            openPullRequest({ headSha: undefined }),
        ]) {
            tracker.settle(pullRequest, 0);
            expect(tracker.settle(pullRequest, EMPTY_CHECK_ROLLUP_GRACE_MS)?.state).toBe('pending');
        }
    });
});
