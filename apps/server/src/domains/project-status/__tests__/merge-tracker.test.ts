import type {
    ProjectStatusRepository,
    ProjectStatusSummary,
    SessionPullRequest,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { ProjectStatusMergeTracker } from '../merge-tracker';

const PRIMARY_URL = 'https://github.com/example/app/pull/7';
const SUBMODULE_URL = 'https://github.com/example/library/pull/12';

function repo(
    kind: ProjectStatusRepository['kind'],
    url: string,
    lifecycle: SessionPullRequest['state'],
    mergedAt?: number,
): ProjectStatusRepository {
    return {
        id: `${kind}-repo`,
        kind,
        name: kind,
        rootPath: `/workspace/${kind}`,
        branch: 'feat/example',
        acceptances: [],
        linearIssues: [],
        errors: [],
        pullRequest: {
            number: 1,
            title: 'Example',
            url,
            lifecycle,
            ...(mergedAt !== undefined && { mergedAt }),
            state: 'neutral',
            checks: [],
            hiddenCheckCount: 0,
        },
    };
}

function snapshot(...repositories: ProjectStatusRepository[]): ProjectStatusSummary {
    return { repositories, refreshedAt: 0 };
}

describe('ProjectStatusMergeTracker', () => {
    it('reports a submodule pull request that was open and is now merged', () => {
        let now = 1_000;
        const tracker = new ProjectStatusMergeTracker({ now: () => now });
        const primaryOpen = repo('primary', PRIMARY_URL, 'open');
        const open = snapshot(primaryOpen, repo('submodule', SUBMODULE_URL, 'open'));
        expect(tracker.observe('s1', open)).toEqual([]);
        now = 2_000;
        const merged = snapshot(primaryOpen, repo('submodule', SUBMODULE_URL, 'merged', 1_500));
        expect(tracker.observe('s1', merged)).toEqual([{ url: SUBMODULE_URL, mergedAt: 1_500 }]);
        expect(tracker.observe('s1', merged)).toEqual([]);
    });

    it('stays silent for a merge older than the tracker, and announces a fresh first-seen one', () => {
        let now = 10_000;
        const tracker = new ProjectStatusMergeTracker({ now: () => now });
        const old = snapshot(repo('submodule', SUBMODULE_URL, 'merged', 5_000));
        expect(tracker.observe('s1', old)).toEqual([]);
        now = 20_000;
        const fresh = snapshot(repo('nested', PRIMARY_URL, 'merged', 15_000));
        expect(tracker.observe('s2', fresh)).toEqual([{ url: PRIMARY_URL, mergedAt: 15_000 }]);
    });

    it('tracks each Session separately and ignores closed pull requests', () => {
        const tracker = new ProjectStatusMergeTracker({ now: () => 0 });
        const open = snapshot(repo('submodule', SUBMODULE_URL, 'open'));
        tracker.observe('s1', open);
        tracker.observe('s2', open);
        const merged = snapshot(repo('submodule', SUBMODULE_URL, 'merged', 1));
        expect(tracker.observe('s2', merged)).toEqual([{ url: SUBMODULE_URL, mergedAt: 1 }]);
        const closed = snapshot(repo('submodule', SUBMODULE_URL, 'closed'));
        expect(tracker.observe('s1', closed)).toEqual([]);
    });
});
