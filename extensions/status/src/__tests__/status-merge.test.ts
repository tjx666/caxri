import type { ProjectStatusRepository, TreeItemRichTooltip } from 'caxri';
import { describe, expect, it } from 'vitest';

import {
    currentBranchMerge,
    failedChecksSummary,
    MERGE_PULL_REQUEST_COMMAND,
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

/**
 * The row's merge button; failed checks put the Agent's `Fix` before it.
 */
function mergeButton(row: ReturnType<typeof pullRequestRow>) {
    return row.actions?.find((action) => action.command.command === MERGE_PULL_REQUEST_COMMAND);
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
        [{ state: 'pending', mergeBlocker: 'checks-running' }, 'Checks are still running.'],
        [{ state: 'failure', mergeBlocker: 'checks-failed' }, 'Some checks did not pass.'],
        [
            {
                state: 'failure',
                mergeBlocker: 'checks-failed',
                checks: [
                    { name: 'lint', state: 'failure' },
                    { name: 'unit', state: 'success' },
                    { name: 'e2e', state: 'cancelled' },
                ],
            },
            '2 of 3 checks failed: lint, e2e.',
        ],
        [
            { mergeState: 'blocked', mergeBlocker: 'branch-protection' },
            'branch protection requirement',
        ],
        [{ mergeState: 'behind', mergeBlocker: 'behind' }, 'behind its base'],
        [
            { mergeState: 'unknown', mergeBlocker: 'mergeability-unknown' },
            'has not finished checking',
        ],
    ] as const)('asks before merging when %o', (pullRequest, reason) => {
        const confirmation = mergeButton(
            pullRequestRow(pullRequest as Parameters<typeof pullRequestRow>[0]),
        )?.confirmation;

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
        ['squash', 'Squash and merge into main.', 'Squash and Merge'],
        [
            'merge',
            'Create a merge commit into main. This repository does not allow squash merging.',
            'Create Merge Commit',
        ],
        [
            'rebase',
            'Rebase and merge into main. This repository allows neither squash merging nor merge commits.',
            'Rebase and Merge',
        ],
    ] as const)(
        'names the %s method the merge will use, before the click',
        (mergeMethod, note, confirmLabel) => {
            const clean = pullRequestRow({ baseBranch: 'main', mergeMethod }).actions![0];
            expect(clean.tooltip).toBe(note);

            const blocked = mergeButton(
                pullRequestRow({
                    baseBranch: 'main',
                    mergeMethod,
                    mergeState: 'blocked',
                    mergeBlocker: 'branch-protection',
                }),
            )!;
            expect(blocked.confirmation?.message).toContain(note);
            expect(blocked.confirmation?.confirmLabel).toBe(confirmLabel);
        },
    );

    it('keeps the override label when merging past failed checks, with the method in the message', () => {
        const action = mergeButton(
            pullRequestRow({
                state: 'failure',
                mergeBlocker: 'checks-failed',
                baseBranch: 'main',
                mergeMethod: 'squash',
            }),
        )!;
        expect(action.confirmation?.confirmLabel).toBe('Merge Anyway');
        expect(action.confirmation?.message).toContain('Squash and merge into main.');
    });

    it.each([
        [{ state: 'failure', mergeBlocker: 'checks-failed' }, 'Checks did not pass', 'danger'],
        // Settles by itself, so it is not a warning the user has to act on.
        [{ state: 'pending', mergeBlocker: 'checks-running' }, 'Checks still running', 'neutral'],
        [
            { mergeState: 'blocked', mergeBlocker: 'branch-protection' },
            'Blocked by branch protection',
            'warning',
        ],
        [{ mergeState: 'behind', mergeBlocker: 'behind' }, 'Behind its base branch', 'warning'],
        [
            { mergeState: 'unknown', mergeBlocker: 'mergeability-unknown' },
            'Checking mergeability',
            'neutral',
        ],
    ] as const)('flags a blocked merge %o and names why', (pullRequest, reason, tone) => {
        const action = mergeButton(pullRequestRow(pullRequest));
        // A blocked merge is not the next step, so it is a colored glyph and leaves the row's width to the title.
        expect(action).toMatchObject({ tone });
        expect(action?.label).toBeUndefined();
        expect(action?.icon.id).toBe('git-merge');
        // The reason is the tooltip, never the command title, so a failure toast cannot repeat a stale reason.
        expect(action?.command.title).toBe('Merge Pull Request');
        expect(action?.tooltip).toBe(reason);
    });

    it("puts the Agent's Fix before the merge glyph when checks failed, and only then", () => {
        const failed = pullRequestRow({
            state: 'failure',
            mergeBlocker: 'checks-failed',
            checks: [
                {
                    name: 'lint',
                    state: 'failure',
                    url: 'https://github.com/acme/widget/actions/runs/7',
                },
            ],
        });
        expect(failed.actions?.map((action) => action.label ?? action.icon.id)).toEqual([
            'Fix',
            'git-merge',
        ]);
        expect(failed.actions?.[0]).toMatchObject({ tone: 'danger' });
        expect(failed.actions?.[0]?.command.command).toBe('caxri.sendToAgent');
        for (const pullRequest of [
            {},
            { state: 'pending', mergeBlocker: 'checks-running' },
            { mergeState: 'conflicting', mergeBlocker: 'conflicting' },
        ] as const)
            expect(
                pullRequestRow(pullRequest).actions?.map(
                    (action) => action.label ?? action.icon.id,
                ),
            ).not.toContain('Fix');
        expect(
            pullRequestRow({ state: 'failure', mergeBlocker: 'checks-failed', lifecycle: 'draft' })
                .actions,
        ).toHaveLength(1);
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
        const action = pullRequestRow({ mergeState: 'conflicting', mergeBlocker: 'conflicting' })
            .actions?.[0];
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
            pullRequestRow({ mergeState: 'conflicting', mergeBlocker: 'conflicting' })
                .accessibilityInformation?.label,
        ).toContain('has conflicts');
    });

    it.each([{ lifecycle: 'merged' }, { lifecycle: 'closed' }, { headSha: undefined }] as const)(
        'offers no merge for %o',
        (pullRequest) => {
            expect(pullRequestRow(pullRequest).actions).toBeUndefined();
        },
    );
});

describe('mergeReadinessLabel', () => {
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
        [undefined, 'Ready to merge'],
        ['conflicting', 'Has conflicts'],
        ['checks-failed', 'Checks did not pass'],
        ['checks-running', 'Checks still running'],
        ['branch-protection', 'Blocked by branch protection'],
        ['behind', 'Behind its base branch'],
        ['mergeability-unknown', 'Checking mergeability'],
    ] as const)('labels %s as %s', (mergeBlocker, label) => {
        expect(mergeReadinessLabel({ ...base, mergeBlocker })).toBe(label);
    });

    it('names the failing checks in the hover card even when GitHub calls the branch clean', () => {
        expect(
            (
                pullRequestRow({ state: 'failure', mergeBlocker: 'checks-failed' })
                    .tooltip as TreeItemRichTooltip
            ).rows,
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
        [{ mergeState: 'conflicting', mergeBlocker: 'conflicting' }, 'has conflicts'],
        [
            { state: 'failure', mergeBlocker: 'checks-failed' },
            'Use the merge button in the Status panel',
        ],
    ] as const)('refuses %o instead of merging without a confirmation', (pullRequest, message) => {
        const decision = currentBranchMerge([repo(pullRequest)]);
        expect(decision.kind).toBe('refuse');
        expect(decision.kind === 'refuse' && decision.message).toContain(message);
    });
});
