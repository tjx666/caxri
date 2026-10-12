import type { ProjectStatusRepository, TreeItemRichTooltip } from 'caxri';
import { describe, expect, it } from 'vitest';

import {
    currentBranchMerge,
    failedChecksSummary,
    MERGE_PULL_REQUEST_COMMAND,
    mergeBlocker,
    mergeReadinessLabel,
} from '../status-merge';
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
        expect(action).toMatchObject({ label: 'Merge', tone: 'success' });
        // The method is picked when the merge runs, so the button states the selection order up front.
        expect(action.tooltip).toContain('Squash and merge');
        expect(action.confirmation).toBeUndefined();
        expect(action.feedback).toEqual({
            success: 'Merged #42',
            failure: "Couldn't merge #42",
            githubUrl: 'https://github.com/acme/widget/pull/42',
        });
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
        [
            {
                state: 'failure',
                checks: [
                    { name: 'lint', state: 'failure' },
                    { name: 'unit', state: 'success' },
                    { name: 'e2e', state: 'cancelled' },
                ],
            },
            '2 of 3 checks failed: lint, e2e.',
        ],
        [{ mergeState: 'blocked' }, 'branch protection requirement'],
        [{ mergeState: 'behind' }, 'behind its base'],
        [{ mergeState: 'unknown' }, 'has not finished checking'],
    ] as const)('asks before merging when %o', (pullRequest, reason) => {
        const confirmation = pullRequestRow(pullRequest as Parameters<typeof pullRequestRow>[0])
            .actions?.[0]?.confirmation;

        expect(confirmation).toMatchObject({
            title: 'Merge pull request #42?',
            // Merging past failed checks names the override; every other blocker settles or may be refused by GitHub.
            confirmLabel:
                'state' in pullRequest && pullRequest.state === 'failure'
                    ? 'Merge Anyway'
                    : 'Merge',
        });
        expect(confirmation?.message).toContain(reason);
        expect(confirmation?.message).toContain('Squash and merge when the repository allows it');
    });

    it.each([
        [{ state: 'failure' }, 'Checks did not pass', 'danger'],
        // Settles by itself, so it is not a warning the user has to act on.
        [{ state: 'pending' }, 'Checks still running', 'neutral'],
        [{ mergeState: 'blocked' }, 'Blocked by branch protection', 'warning'],
        [{ mergeState: 'behind' }, 'Behind its base branch', 'warning'],
        [{ mergeState: 'unknown' }, 'Checking mergeability', 'neutral'],
    ] as const)('flags a blocked merge %o and names why', (pullRequest, reason, tone) => {
        const action = pullRequestRow(pullRequest).actions?.[0];
        // A blocked merge is not the next step, so it is a colored glyph and leaves the row's width to the title.
        expect(action).toMatchObject({ tone });
        expect(action?.label).toBeUndefined();
        expect(action?.icon.id).toBe('git-merge');
        // The reason is the tooltip, never the command title, so a failure toast cannot repeat a stale reason.
        expect(action?.command.title).toBe('Merge Pull Request');
        expect(action?.tooltip).toBe(reason);
    });

    it('keeps an explaining button for a draft that opens GitHub instead of merging', () => {
        const action = pullRequestRow({ lifecycle: 'draft' }).actions?.[0];
        expect(action).toMatchObject({
            tone: 'neutral',
            command: {
                command: 'caxri.openExternal',
                arguments: ['https://github.com/acme/widget/pull/42'],
            },
            confirmation: { confirmLabel: 'Open on GitHub' },
        });
        expect(action?.confirmation?.title).toContain('Open draft pull request #42 on GitHub?');
    });

    it("offers the Agent's Resolve button for a conflict instead of a merge GitHub would refuse", () => {
        const action = pullRequestRow({ mergeState: 'conflicting' }).actions?.[0];
        expect(action).toMatchObject({
            label: 'Resolve',
            tone: 'danger',
            command: { command: 'caxri.sendToAgent', title: 'Resolve Conflicts with Agent' },
        });
        expect(action?.command.arguments?.[0]).toContain('rebase `feat/merge`');
        expect(action?.confirmation).toBeUndefined();
    });

    it('names a conflict in the row accessible label', () => {
        expect(
            pullRequestRow({ mergeState: 'conflicting' }).accessibilityInformation?.label,
        ).toContain('has conflicts');
    });

    it.each([{ lifecycle: 'merged' }, { lifecycle: 'closed' }, { headSha: undefined }] as const)(
        'offers no merge for %o',
        (pullRequest) => {
            expect(pullRequestRow(pullRequest).actions).toBeUndefined();
        },
    );
});

describe('mergeBlocker', () => {
    const base: PullRequest = {
        number: 42,
        title: 'Delivery',
        url: 'https://github.com/acme/widget/pull/42',
        lifecycle: 'open',
        state: 'success',
        checks: [],
        hiddenCheckCount: 0,
        headSha: HEAD,
        mergeState: 'clean',
    };

    it.each([
        [{}, undefined, 'Ready to merge'],
        [{ mergeState: 'unstable' }, undefined, 'Ready to merge'],
        [{ mergeState: 'conflicting', state: 'failure' }, 'conflicting', 'Has conflicts'],
        [{ state: 'cancelled' }, 'checks-failed', 'Checks did not pass'],
        [{ state: 'queued' }, 'checks-running', 'Checks still running'],
        [{ mergeState: 'blocked' }, 'branch-protection', 'Blocked by branch protection'],
        [{ mergeState: 'behind' }, 'behind', 'Behind its base branch'],
        [{ mergeState: 'unknown' }, 'mergeability-unknown', 'Checking mergeability'],
    ] as const)('reads %o as %s', (pullRequest, blocker, label) => {
        expect(mergeBlocker({ ...base, ...pullRequest })).toBe(blocker);
        expect(mergeReadinessLabel({ ...base, ...pullRequest })).toBe(label);
    });

    it('names the failing checks in the hover card even when GitHub calls the branch clean', () => {
        expect(
            (pullRequestRow({ state: 'failure' }).tooltip as TreeItemRichTooltip).rows,
        ).toContainEqual({
            label: 'merge',
            value: 'Checks did not pass',
        });
    });
});

describe('failedChecksSummary', () => {
    it('names at most three failing checks and counts the rest', () => {
        const checks = ['a', 'b', 'c', 'd', 'e'].map((name) => ({
            name,
            state: 'failure' as const,
        }));
        expect(failedChecksSummary({ checks: [...checks, { name: 'ok', state: 'success' }] })).toBe(
            '5 of 6 checks failed: a, b, c, and 2 more.',
        );
    });
});

describe('currentBranchMerge', () => {
    const repo = (pullRequest?: Partial<PullRequest>): ProjectStatusRepository => ({
        id: 'repository-1',
        kind: 'primary',
        name: 'widget',
        branch: 'feat/merge',
        acceptances: [],
        linearIssues: [],
        errors: [],
        ...(pullRequest && {
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
        }),
    });

    it('merges a clean pull request on the primary repository', () => {
        expect(currentBranchMerge([repo({})])).toEqual({
            kind: 'merge',
            arguments: { repositoryId: 'repository-1', number: 42, headSha: HEAD },
        });
    });

    it.each([
        [undefined, 'has no pull request'],
        [{ lifecycle: 'draft' }, 'is a draft'],
        [{ mergeState: 'conflicting' }, 'has conflicts'],
        [{ state: 'failure' }, 'Use the merge button in the Status panel'],
    ] as const)('refuses %o instead of merging without a confirmation', (pullRequest, message) => {
        const decision = currentBranchMerge([repo(pullRequest)]);
        expect(decision.kind).toBe('refuse');
        expect(decision.kind === 'refuse' && decision.message).toContain(message);
    });
});
