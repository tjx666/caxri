import type { ProjectStatusRepository, TreeItemRichTooltip } from 'caxri';
import { describe, expect, it } from 'vitest';

import { MERGE_PULL_REQUEST_COMMAND } from '../status-merge';
import { buildRepoNode } from '../status-tree';

type PullRequest = NonNullable<ProjectStatusRepository['pullRequest']>;

const HEAD = 'a'.repeat(40);

function pullRequestRow(pullRequest: Partial<PullRequest>) {
    const root = buildRepoNode({
        id: 'repository-1',
        kind: 'primary',
        name: 'widget',
        branch: 'feat/merge',
        acceptances: [],
        linearIssues: [],
        errors: [],
        pullRequest: {
            number: 42,
            title: 'Delivery',
            url: 'https://github.com/acme/widget/pull/42',
            lifecycle: 'open',
            state: 'success',
            checks: [],
            hiddenCheckCount: 0,
            headSha: HEAD,
            mergeState: 'clean',
            ...pullRequest,
        },
    });
    return root.children!.find((node) => node.item.id?.endsWith(':pr'))!.item;
}

describe('Status panel merge action', () => {
    it('merges a green, clean pull request without asking, pinned to the head the row shows', () => {
        const row = pullRequestRow({});

        expect(row.actions).toHaveLength(1);
        const action = row.actions![0];
        expect(action.command).toEqual({
            command: MERGE_PULL_REQUEST_COMMAND,
            title: 'Merge Pull Request',
            arguments: [{ repositoryId: 'repository-1', number: 42, headSha: HEAD }],
        });
        expect(action.icon.id).toBe('git-merge');
        expect(action.confirmation).toBeUndefined();
        expect((row.tooltip as TreeItemRichTooltip).rows).toContainEqual({
            label: 'merge',
            value: 'Ready to merge',
        });
    });

    /**
     * GitHub calls a pull request `unstable` when a non-required check is red or running, including a check the user
     * told Caxri to ignore. The panel's own rollup already excluded it, so asking again would make every merge modal.
     */
    it('does not ask again about a check the panel already filtered out', () => {
        expect(
            pullRequestRow({ mergeState: 'unstable' }).actions?.[0]?.confirmation,
        ).toBeUndefined();
    });

    it.each([
        [{ state: 'pending' }, 'Checks are still running.'],
        [{ state: 'failure' }, 'Some checks did not pass.'],
        [{ mergeState: 'blocked' }, 'branch protection requirement'],
        [{ mergeState: 'behind' }, 'behind its base'],
        [{ mergeState: 'unknown' }, 'has not finished checking'],
    ] as const)('asks before merging when %o', (pullRequest, reason) => {
        const confirmation = pullRequestRow(pullRequest).actions?.[0]?.confirmation;

        expect(confirmation).toMatchObject({
            title: 'Merge pull request #42?',
            confirmLabel: 'Merge',
        });
        expect(confirmation?.message).toContain(reason);
    });

    it.each([
        { lifecycle: 'draft' },
        { lifecycle: 'merged' },
        { lifecycle: 'closed' },
        { mergeState: 'conflicting' },
        { headSha: undefined },
    ] as const)('offers no merge for %o', (pullRequest) => {
        expect(pullRequestRow(pullRequest).actions).toBeUndefined();
    });
});
