import type { ProjectStatusRepository as ProjectStatusRepo } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { StalePullRequestHeadTracker } from '../stale-pull-request-head';

type PullRequest = NonNullable<ProjectStatusRepo['pullRequest']>;

const oldHead = 'a'.repeat(40);
const pushedHead = 'b'.repeat(40);
const nextHead = 'c'.repeat(40);

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
    return {
        number: 42,
        title: 'Ship status panel',
        url: 'https://github.com/example/project/pull/42',
        lifecycle: 'open',
        state: 'success',
        checks: [],
        hiddenCheckCount: 0,
        headSha: oldHead,
        headBranch: 'feature/status',
        ...overrides,
    };
}

const pushed = { branch: 'feature/status', trackingHead: pushedHead };

describe('StalePullRequestHeadTracker', () => {
    it('refetches a cached record once the local branch was pushed past it', () => {
        const tracker = new StalePullRequestHeadTracker();
        expect(tracker.shouldRefetch(pullRequest(), pushed)).toBe(true);
    });

    it('spends one refetch per pushed head, so a lagging GitHub cannot loop', () => {
        const tracker = new StalePullRequestHeadTracker();
        tracker.shouldRefetch(pullRequest(), pushed);
        expect(tracker.shouldRefetch(pullRequest(), pushed)).toBe(false);
        expect(tracker.shouldRefetch(pullRequest(), { ...pushed, trackingHead: nextHead })).toBe(
            true,
        );
    });

    it('serves the refetched record so the merge button carries the pushed head', async () => {
        const records = [pullRequest(), pullRequest({ headSha: pushedHead })];
        const view = vi.fn<(maxAgeMs: number | undefined) => Promise<string>>(() =>
            Promise.resolve(JSON.stringify(records.shift())),
        );
        const parsed = await new StalePullRequestHeadTracker().read(pushed, false, {
            view,
            parse: (output) => ({ pullRequest: JSON.parse(output) as PullRequest }),
        });
        expect(view.mock.calls).toEqual([[undefined], [0]]);
        expect(parsed?.pullRequest.headSha).toBe(pushedHead);
    });

    it.each([
        ['the record already has the pushed head', pullRequest({ headSha: pushedHead }), pushed],
        ['the branch has no tracking ref', pullRequest(), { branch: 'feature/status' }],
        [
            'the pull request belongs to another branch',
            pullRequest({ headBranch: 'feature/other' }),
            pushed,
        ],
        ['the pull request merged', pullRequest({ lifecycle: 'merged' }), pushed],
        ['GitHub reported no head', pullRequest({ headSha: undefined }), pushed],
    ] as const)('keeps the cached record when %s', (_case, record, context) => {
        expect(new StalePullRequestHeadTracker().shouldRefetch(record, context)).toBe(false);
    });
});
