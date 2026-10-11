import type { ProjectStatusRepository, TreeItemAction, TreeItemActionTone } from 'caxri';
import { ThemeIcon } from 'caxri';

export const MERGE_PULL_REQUEST_COMMAND = 'caxri.project-status.mergePullRequest';
export const MERGE_CURRENT_PULL_REQUEST_COMMAND = 'caxri.project-status.mergeCurrentPullRequest';
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

const mergeConfirmationReasons: Record<
    Exclude<MergeBlocker, 'checks-failed' | 'conflicting'>,
    string
> = {
    'checks-running': 'Checks are still running.',
    'branch-protection':
        'GitHub reports a branch protection requirement is not met yet, so it may refuse the merge.',
    'behind': 'The branch is behind its base, so GitHub may require updating it first.',
    'mergeability-unknown': 'GitHub has not finished checking whether this pull request can merge.',
};

const failedCheckStates = new Set<PullRequest['state']>(['failure', 'cancelled']);
const NAMED_FAILED_CHECKS = 3;

/**
 * `2 of 9 checks failed: lint, e2e.` from the panel's own filtered checks, so the confirmation says which checks the
 * user is about to merge past instead of a bare "some checks did not pass". Falls back to that sentence when the rollup
 * failed but no listed check did (a check hidden by an ignore pattern still drove GitHub's state).
 */
export function failedChecksSummary(pullRequest: Pick<PullRequest, 'checks'>): string {
    const failed = pullRequest.checks.filter((check) => failedCheckStates.has(check.state));
    if (failed.length === 0) return 'Some checks did not pass.';
    const named = failed.slice(0, NAMED_FAILED_CHECKS).map((check) => check.name);
    const rest = failed.length - named.length;
    const names = rest > 0 ? `${named.join(', ')}, and ${rest} more` : named.join(', ');
    return `${failed.length} of ${pullRequest.checks.length} ${pullRequest.checks.length === 1 ? 'check' : 'checks'} failed: ${names}.`;
}

/**
 * Tone of the merge glyph for a blocker that still allows merging after a confirmation. Only failed checks are
 * `danger`; an unmet protection rule or a stale base is `warning` because GitHub may refuse; checks still running or a
 * mergeability GitHub has not computed yet are `neutral`, because they settle by themselves and are not a problem the
 * user has to fix.
 */
const blockerTones: Record<Exclude<MergeBlocker, 'conflicting'>, TreeItemActionTone> = {
    'checks-failed': 'danger',
    'branch-protection': 'warning',
    'behind': 'warning',
    'checks-running': 'neutral',
    'mergeability-unknown': 'neutral',
};

/**
 * The always-visible merge button. Only a merge nothing blocks earns the green `Merge` text: it is the next step, so it
 * is worth the room it takes from the title. A blocked merge is not the next step, so it shrinks to the merge glyph,
 * colored by {@link blockerTones}, and leaves the narrow sidebar's width to the pull request title. The reason is the
 * button's tooltip (on hover and keyboard focus) and the confirmation's message; the command title stays the plain
 * action name so a failure toast never repeats a stale reason.
 */
function mergeButtonPresentation(
    blocker: Exclude<MergeBlocker, 'conflicting'> | undefined,
): Pick<TreeItemAction, 'icon' | 'label' | 'tone' | 'tooltip'> {
    if (!blocker) return { icon: new ThemeIcon('git-merge'), label: 'Merge', tone: 'success' };
    return {
        icon: new ThemeIcon('git-merge'),
        tone: blockerTones[blocker],
        tooltip: mergeBlockerLabels[blocker],
    };
}

/**
 * A merge GitHub cannot perform at all (a draft, or a conflict with the base branch) keeps its button so the row still
 * answers "can I merge this?", but the button explains why not and offers the pull request on GitHub, where the user
 * resolves it. It never dispatches the merge command.
 */
function unmergeableAction(
    pullRequest: PullRequest,
    reason: 'conflicting' | 'draft',
): TreeItemAction {
    const isDraft = reason === 'draft';
    return {
        command: {
            command: 'caxri.openExternal',
            title: MERGE_PULL_REQUEST_TITLE,
            arguments: [pullRequest.url],
        },
        icon: new ThemeIcon('git-merge'),
        tone: isDraft ? 'neutral' : 'danger',
        tooltip: isDraft
            ? "Draft pull requests can't be merged"
            : 'Has conflicts. Resolve them on GitHub.',
        confirmation: isDraft
            ? {
                  title: `Pull request #${pullRequest.number} is a draft`,
                  message:
                      "GitHub can't merge a draft pull request. Mark it ready for review on GitHub, then merge it here.",
                  confirmLabel: 'Open on GitHub',
              }
            : {
                  title: `Pull request #${pullRequest.number} has conflicts`,
                  message:
                      "GitHub can't merge it until the conflicts with its base branch are resolved. Resolve them on GitHub, then merge it here.",
                  confirmLabel: 'Open on GitHub',
              },
    };
}

/**
 * The PR row's inline merge button, for an open or draft pull request. A draft or a conflict gets the explaining button
 * from {@link unmergeableAction}. Otherwise the button needs the head Caxri knows, so the merge is pinned to it. A merge
 * with clean checks is a single click by design, with no confirmation; every other {@link mergeBlocker} reason (failing
 * or running checks, unmet protection, a stale base) asks first.
 *
 * The merge method is chosen by Server Core from the repository's allowed methods only when the merge runs, so neither
 * the button nor the confirmation can name it yet; they say "Merge".
 */
export function mergePullRequestAction(
    repo: Pick<ProjectStatusRepository, 'id'>,
    pullRequest: PullRequest,
): TreeItemAction | undefined {
    if (pullRequest.lifecycle === 'draft') return unmergeableAction(pullRequest, 'draft');
    if (pullRequest.lifecycle !== 'open') return undefined;
    const blocker = mergeBlocker(pullRequest);
    if (blocker === 'conflicting') return unmergeableAction(pullRequest, 'conflicting');
    if (!pullRequest.headSha) return undefined;
    const reason =
        blocker &&
        (blocker === 'checks-failed'
            ? failedChecksSummary(pullRequest)
            : mergeConfirmationReasons[blocker]);
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
        ...mergeButtonPresentation(blocker),
        ...(reason && {
            confirmation: {
                title: `Merge pull request #${pullRequest.number}?`,
                message: `${reason} A merged pull request cannot be undone from Caxri.`,
                confirmLabel: 'Merge',
            },
        }),
        feedback: {
            // Fallback only: the command's own `mergedMessage` result names the method Server Core chose.
            success: `Merged #${pullRequest.number}`,
            failure: `Couldn't merge #${pullRequest.number}`,
            githubUrl: pullRequest.url,
        },
    };
}

/**
 * What the palette's "Merge Pull Request for Current Branch" does: merge the primary repository's pull request when
 * nothing blocks it, or refuse with the reason. The palette has no confirmation step, so any merge that the Status
 * panel would confirm is refused here and pointed back at the panel's button, which can ask.
 */
export type CurrentBranchMerge =
    { kind: 'merge'; arguments: MergePullRequestArguments } | { kind: 'refuse'; message: string };

export function currentBranchMerge(
    repositories: readonly ProjectStatusRepository[],
): CurrentBranchMerge {
    const repo = repositories.find((candidate) => candidate.kind === 'primary');
    const pullRequest = repo?.pullRequest;
    if (!repo || !pullRequest)
        return { kind: 'refuse', message: 'The current branch has no pull request.' };
    const label = `Pull request #${pullRequest.number}`;
    if (pullRequest.lifecycle === 'draft')
        return {
            kind: 'refuse',
            message: `${label} is a draft. Mark it ready for review on GitHub first.`,
        };
    if (pullRequest.lifecycle !== 'open')
        return {
            kind: 'refuse',
            message: `${label} is ${pullRequest.lifecycle ?? 'not open'}, so there is nothing to merge.`,
        };
    const blocker = mergeBlocker(pullRequest);
    if (blocker === 'conflicting')
        return { kind: 'refuse', message: `${label} has conflicts. Resolve them on GitHub first.` };
    if (blocker)
        return {
            kind: 'refuse',
            message: `${label} is not ready to merge: ${mergeBlockerLabels[blocker].toLowerCase()}. Use the merge button in the Status panel to merge it anyway.`,
        };
    if (!pullRequest.headSha)
        return {
            kind: 'refuse',
            message: `${label} has no known head commit yet. Refresh Project Status and try again.`,
        };
    return {
        kind: 'merge',
        arguments: {
            repositoryId: repo.id,
            number: pullRequest.number,
            headSha: pullRequest.headSha,
        },
    };
}

const mergeMethodVerbs = {
    squash: 'Squash-merged',
    merge: 'Merged',
    rebase: 'Rebase-merged',
} as const;

/**
 * Success toast text naming the merge method Server Core picked, which is only known once the merge has happened.
 */
export function mergedMessage(method: keyof typeof mergeMethodVerbs, number: number): string {
    return `${mergeMethodVerbs[method]} #${number}`;
}
