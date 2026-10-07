import type { ProjectStatusRepository, PullRequestMergeState, TreeItemAction } from 'caxri';
import { ThemeIcon } from 'caxri';

export const MERGE_PULL_REQUEST_COMMAND = 'caxri.project-status.mergePullRequest';
const MERGE_PULL_REQUEST_TITLE = 'Merge Pull Request';

type PullRequest = NonNullable<ProjectStatusRepository['pullRequest']>;

/**
 * What the merge command receives. It carries the head the row showed, so the merge is pinned to what the user looked
 * at rather than to whatever the branch points at by the time GitHub answers.
 */
export interface MergePullRequestArguments {
    repositoryId: string;
    number: number;
    headSha: string;
}

export function isMergePullRequestArguments(value: unknown): value is MergePullRequestArguments {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.repositoryId === 'string' &&
        typeof candidate.number === 'number' &&
        typeof candidate.headSha === 'string'
    );
}

const mergeStateLabels: Record<PullRequestMergeState, string> = {
    clean: 'Ready to merge',
    unstable: 'Ready to merge',
    blocked: 'Blocked by branch protection',
    behind: 'Behind its base branch',
    conflicting: 'Has conflicts',
    unknown: 'Checking mergeability',
};

export function mergeStateLabel(state: PullRequestMergeState): string {
    return mergeStateLabels[state];
}

const unsettledCheckStates = new Set<PullRequest['state']>(['pending', 'queued', 'unknown']);

/**
 * Why merging right now deserves a second look, or nothing when it does not. Read from the panel's own filtered check
 * rollup rather than from GitHub's `unstable`: a check the user chose to ignore is already a decision, and asking again
 * about it would turn every merge into a confirmation.
 */
function mergeConfirmationReason(pullRequest: PullRequest): string | undefined {
    if (pullRequest.state === 'failure' || pullRequest.state === 'cancelled')
        return 'Some checks did not pass.';
    if (unsettledCheckStates.has(pullRequest.state)) return 'Checks are still running.';
    switch (pullRequest.mergeState) {
        case 'blocked':
            return 'GitHub reports a branch protection requirement is not met yet, so it may refuse the merge.';
        case 'behind':
            return 'The branch is behind its base, so GitHub may require updating it first.';
        case 'unknown':
            return 'GitHub has not finished checking whether this pull request can merge.';
        default:
            return undefined;
    }
}

/**
 * The PR row's inline merge button. Offered only for an open pull request whose head Caxri knows and that GitHub does
 * not already report as conflicting; a draft or a conflict has to be resolved on GitHub first, and the row's hover card
 * says so instead.
 */
export function mergePullRequestAction(
    repo: Pick<ProjectStatusRepository, 'id'>,
    pullRequest: PullRequest,
): TreeItemAction | undefined {
    if (pullRequest.lifecycle !== 'open' || !pullRequest.headSha) return undefined;
    if (pullRequest.mergeState === 'conflicting') return undefined;
    const reason = mergeConfirmationReason(pullRequest);
    const arguments_: MergePullRequestArguments = {
        repositoryId: repo.id,
        number: pullRequest.number,
        headSha: pullRequest.headSha,
    };
    return {
        command: {
            command: MERGE_PULL_REQUEST_COMMAND,
            title: MERGE_PULL_REQUEST_TITLE,
            arguments: [arguments_],
        },
        icon: new ThemeIcon('git-merge'),
        ...(reason && {
            confirmation: {
                title: `Merge pull request #${pullRequest.number}?`,
                message: `${reason} A merged pull request cannot be undone from Caxri.`,
                confirmLabel: 'Merge',
            },
        }),
    };
}
