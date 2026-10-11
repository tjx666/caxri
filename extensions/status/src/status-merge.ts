import type { ProjectStatusRepository, TreeItemAction, TreeItemActionTone } from 'caxri';
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

const unsettledCheckStates = new Set<PullRequest['state']>(['pending', 'queued', 'unknown']);

/**
 * Why an open pull request is not plainly ready to merge, as a closed reason. Checks come from the panel's own filtered
 * rollup rather than from GitHub's `unstable`: a check the user chose to ignore is already a decision, and asking again
 * about it would turn every merge into a confirmation. `conflicting` blocks the merge outright; every other reason only
 * asks first.
 */
export type MergeBlocker =
    | 'conflicting'
    | 'checks-failed'
    | 'checks-running'
    | 'branch-protection'
    | 'behind'
    | 'mergeability-unknown';

export function mergeBlocker(pullRequest: PullRequest): MergeBlocker | undefined {
    if (pullRequest.mergeState === 'conflicting') return 'conflicting';
    if (pullRequest.state === 'failure' || pullRequest.state === 'cancelled')
        return 'checks-failed';
    if (unsettledCheckStates.has(pullRequest.state)) return 'checks-running';
    switch (pullRequest.mergeState) {
        case 'blocked':
            return 'branch-protection';
        case 'behind':
            return 'behind';
        case 'unknown':
            return 'mergeability-unknown';
        default:
            return undefined;
    }
}

const mergeBlockerLabels: Record<MergeBlocker, string> = {
    'conflicting': 'Has conflicts',
    'checks-failed': 'Checks did not pass',
    'checks-running': 'Checks still running',
    'branch-protection': 'Blocked by branch protection',
    'behind': 'Behind its base branch',
    'mergeability-unknown': 'Checking mergeability',
};

/**
 * The hover card's `merge` row: `Ready to merge`, or the one reason it is not.
 */
export function mergeReadinessLabel(pullRequest: PullRequest): string {
    const blocker = mergeBlocker(pullRequest);
    return blocker ? mergeBlockerLabels[blocker] : 'Ready to merge';
}

const mergeConfirmationReasons: Record<Exclude<MergeBlocker, 'conflicting'>, string> = {
    'checks-failed': 'Some checks did not pass.',
    'checks-running': 'Checks are still running.',
    'branch-protection':
        'GitHub reports a branch protection requirement is not met yet, so it may refuse the merge.',
    'behind': 'The branch is behind its base, so GitHub may require updating it first.',
    'mergeability-unknown': 'GitHub has not finished checking whether this pull request can merge.',
};

/**
 * The always-visible merge button. The label always names the action, so a click never surprises: green `Merge` when
 * nothing stands in the way, and `Merge anyway` behind a warning glyph when something does, colored `--danger` for
 * failed checks and `--warning` for anything still settling. The reason itself is the button's tooltip and the
 * confirmation's message, and the row's own glyph already shows the check state, so the button does not repeat it.
 */
function mergeButtonPresentation(
    blocker: Exclude<MergeBlocker, 'conflicting'> | undefined,
): Pick<TreeItemAction, 'icon' | 'label' | 'tone'> & { title: string } {
    if (!blocker)
        return {
            icon: new ThemeIcon('git-merge'),
            label: 'Merge',
            tone: 'success',
            title: MERGE_PULL_REQUEST_TITLE,
        };
    const tone: TreeItemActionTone = blocker === 'checks-failed' ? 'danger' : 'warning';
    return {
        icon: new ThemeIcon('warning'),
        label: 'Merge anyway',
        tone,
        title: `${MERGE_PULL_REQUEST_TITLE}: ${mergeBlockerLabels[blocker]}`,
    };
}

/**
 * The PR row's inline merge button. Offered only for an open pull request whose head Caxri knows and that GitHub does
 * not already report as conflicting; a draft or a conflict has to be resolved on GitHub first, and the row's hover card
 * says so instead. A merge with clean checks is a single click by design, with no confirmation; every other
 * {@link mergeBlocker} reason (failing or running checks, unmet protection, a stale base) asks first.
 */
export function mergePullRequestAction(
    repo: Pick<ProjectStatusRepository, 'id'>,
    pullRequest: PullRequest,
): TreeItemAction | undefined {
    if (pullRequest.lifecycle !== 'open' || !pullRequest.headSha) return undefined;
    const blocker = mergeBlocker(pullRequest);
    if (blocker === 'conflicting') return undefined;
    const reason = blocker && mergeConfirmationReasons[blocker];
    const { title, ...presentation } = mergeButtonPresentation(blocker);
    const arguments_: MergePullRequestArguments = {
        repositoryId: repo.id,
        number: pullRequest.number,
        headSha: pullRequest.headSha,
    };
    return {
        command: {
            command: MERGE_PULL_REQUEST_COMMAND,
            title,
            arguments: [arguments_],
        },
        ...presentation,
        ...(reason && {
            confirmation: {
                title: `Merge pull request #${pullRequest.number}?`,
                message: `${reason} A merged pull request cannot be undone from Caxri.`,
                confirmLabel: 'Merge',
            },
        }),
    };
}
