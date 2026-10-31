import type {
    ProjectStatusRepository,
    PullRequestMergeBlocker,
    TreeItemAction,
    TreeItemActionTone,
} from 'caxri';
import { l10n, ThemeIcon } from 'caxri';

import { fixFailedChecksAction, resolveConflictsAction } from './status-agent-actions';

export const MERGE_PULL_REQUEST_COMMAND = 'caxri.project-status.mergePullRequest';
export const MERGE_CURRENT_PULL_REQUEST_COMMAND = 'caxri.project-status.mergeCurrentPullRequest';
function mergePullRequestTitle(): string {
    return l10n.t('Merge Pull Request');
}

type MergeMethod = NonNullable<PullRequest['mergeMethod']>;

/**
 * The sentence naming the method, with or without the base branch. Each is a whole message so a translation can place
 * the branch where its language wants it.
 */
function mergeMethodAction(method: MergeMethod, baseBranch: string | undefined): string {
    if (method === 'squash')
        return baseBranch
            ? l10n.t('Squash and merge into {branch}.', { branch: baseBranch })
            : l10n.t('Squash and merge.');
    if (method === 'merge')
        return baseBranch
            ? l10n.t('Create a merge commit into {branch}.', { branch: baseBranch })
            : l10n.t('Create a merge commit.');
    return baseBranch
        ? l10n.t('Rebase and merge into {branch}.', { branch: baseBranch })
        : l10n.t('Rebase and merge.');
}

function mergeMethodConfirmLabel(method: MergeMethod): string {
    if (method === 'squash') return l10n.t('Squash and Merge');
    return method === 'merge' ? l10n.t('Create Merge Commit') : l10n.t('Rebase and Merge');
}

/**
 * The sentence stating what the merge will do, from the method Server Core reported for this repository. A method other
 * than squash also says why: squash is the first choice, so it is only skipped when the repository disallows it, and a
 * rebase pick additionally means merge commits are disallowed.
 */
function mergeMethodNote(pullRequest: PullRequest): string {
    const method = pullRequest.mergeMethod;
    // Fallback when the repository's allowed methods were not read (offline, signed out, or an older projection): states
    // the selection order Server Core applies, because the exact method is unknown.
    if (!method)
        return l10n.t(
            'Squash and merge when the repository allows it, otherwise a merge commit, then rebase.',
        );
    const action = mergeMethodAction(method, pullRequest.baseBranch);
    if (method === 'squash') return action;
    return joinSentences(
        action,
        method === 'merge'
            ? l10n.t('This repository does not allow squash merging.')
            : l10n.t('This repository allows neither squash merging nor merge commits.'),
    );
}

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

/**
 * Why an open pull request is not plainly ready to merge. Caxri computes it once from the panel's own filtered rollup
 * (a check the user chose to ignore is already a decision) and GitHub's merge state, so the phone gives the same
 * answer. `conflicting` blocks the merge outright; every other reason only asks first.
 */
type MergeBlocker = PullRequestMergeBlocker;

const mergeBlockerLabels: Record<MergeBlocker, () => string> = {
    'conflicting': () => l10n.t('Has conflicts'),
    'checks-failed': () => l10n.t('Checks did not pass'),
    'checks-running': () => l10n.t('Checks still running'),
    'branch-protection': () => l10n.t('Blocked by branch protection'),
    'behind': () => l10n.t('Behind its base branch'),
    'mergeability-unknown': () => l10n.t('Checking mergeability'),
};

/**
 * Joins whole sentences. A translated sentence that ends in a full-width stop needs no space before the next one.
 */
function joinSentences(...sentences: string[]): string {
    return sentences.reduce((joined, sentence) =>
        /[。？！]$/u.test(joined) ? `${joined}${sentence}` : `${joined} ${sentence}`,
    );
}

/**
 * The hover card's `merge` row: `Ready to merge`, or the one reason it is not.
 */
export function mergeReadinessLabel(pullRequest: PullRequest): string {
    const blocker = pullRequest.mergeBlocker;
    return blocker ? mergeBlockerLabels[blocker]() : l10n.t('Ready to merge');
}

const mergeConfirmationReasons: Record<
    Exclude<MergeBlocker, 'checks-failed' | 'conflicting'>,
    () => string
> = {
    'checks-running': () => l10n.t('Checks are still running.'),
    'branch-protection': () =>
        l10n.t(
            'GitHub reports a branch protection requirement is not met yet, so it may refuse the merge.',
        ),
    'behind': () =>
        l10n.t('The branch is behind its base, so GitHub may require updating it first.'),
    'mergeability-unknown': () =>
        l10n.t('GitHub has not finished checking whether this pull request can merge.'),
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
    if (failed.length === 0) return l10n.t('Some checks did not pass.');
    const named = failed.slice(0, NAMED_FAILED_CHECKS).map((check) => check.name);
    const rest = failed.length - named.length;
    const values = {
        count: failed.length,
        total: pullRequest.checks.length,
        names: named.join(', '),
        number: rest,
    };
    if (pullRequest.checks.length === 1)
        return rest > 0
            ? l10n.t('{count} of {total} check failed: {names}, and {number} more.', values)
            : l10n.t('{count} of {total} check failed: {names}.', values);
    return rest > 0
        ? l10n.t('{count} of {total} checks failed: {names}, and {number} more.', values)
        : l10n.t('{count} of {total} checks failed: {names}.', values);
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
    pullRequest: PullRequest,
): Pick<TreeItemAction, 'icon' | 'label' | 'tone' | 'tooltip'> {
    if (!blocker)
        return {
            icon: new ThemeIcon('git-merge'),
            label: l10n.t('Merge'),
            tone: 'success',
            tooltip: mergeMethodNote(pullRequest),
        };
    return {
        icon: new ThemeIcon('git-merge'),
        tone: blockerTones[blocker],
        tooltip: mergeBlockerLabels[blocker](),
    };
}

/**
 * A draft keeps its merge button so the row still answers "can I merge this?", but GitHub cannot merge a draft, so the
 * button explains why and offers the pull request on GitHub, where the user marks it ready. It never dispatches the
 * merge command.
 */
function draftAction(pullRequest: PullRequest): TreeItemAction {
    return {
        command: {
            command: 'caxri.openExternal',
            title: mergePullRequestTitle(),
            arguments: [pullRequest.url],
        },
        icon: new ThemeIcon('git-merge'),
        tone: 'neutral',
        tooltip: l10n.t("Draft pull requests can't be merged"),
        confirmation: {
            title: l10n.t('Open draft pull request #{number} on GitHub?', {
                number: pullRequest.number,
            }),
            message: l10n.t(
                "GitHub can't merge a draft pull request. Mark it ready for review on GitHub, then merge it here.",
            ),
            confirmLabel: l10n.t('Open on GitHub'),
        },
    };
}

/**
 * The PR row's inline merge button, for an open or draft pull request. A draft gets the explaining button from
 * {@link draftAction}; a conflict, which GitHub would refuse to merge, gets the Agent's `Resolve` button instead, since
 * resolving it is the next step. Otherwise the button needs the head Caxri knows, so the merge is pinned to it. A merge
 * with clean checks is a single click by design, with no confirmation; every other {@link MergeBlocker} reason (failing
 * or running checks, unmet protection, a stale base) asks first.
 *
 * Server Core projects the method the merge will use (`mergeMethod`, chosen by the same function the merge calls), so
 * the button tooltip and the confirmation name it ({@link mergeMethodNote}); without it they state the selection order.
 * Merging past failed checks is labelled `Merge Anyway`, so the button names the override rather than the ordinary
 * action.
 */
function mergePullRequestAction(
    repo: Pick<ProjectStatusRepository, 'branch' | 'defaultBranch' | 'id' | 'kind' | 'name'>,
    pullRequest: PullRequest,
): TreeItemAction | undefined {
    if (pullRequest.lifecycle === 'draft') return draftAction(pullRequest);
    if (pullRequest.lifecycle !== 'open') return undefined;
    const blocker = pullRequest.mergeBlocker;
    if (blocker === 'conflicting') return resolveConflictsAction(repo, pullRequest);
    if (!pullRequest.headSha) return undefined;
    const reason =
        blocker &&
        (blocker === 'checks-failed'
            ? failedChecksSummary(pullRequest)
            : mergeConfirmationReasons[blocker]());
    const arguments_: MergePullRequestArguments = {
        repositoryId: repo.id,
        number: pullRequest.number,
        headSha: pullRequest.headSha,
    };
    return {
        command: {
            command: MERGE_PULL_REQUEST_COMMAND,
            title: mergePullRequestTitle(),
            arguments: [arguments_],
        },
        ...mergeButtonPresentation(blocker, pullRequest),
        ...(reason && {
            confirmation: {
                title: l10n.t('Merge pull request #{number}?', { number: pullRequest.number }),
                message: joinSentences(
                    reason,
                    mergeMethodNote(pullRequest),
                    l10n.t('A merged pull request cannot be undone from Caxri.'),
                ),
                confirmLabel:
                    blocker === 'checks-failed'
                        ? l10n.t('Merge Anyway')
                        : pullRequest.mergeMethod
                          ? mergeMethodConfirmLabel(pullRequest.mergeMethod)
                          : l10n.t('Merge'),
            },
        }),
        feedback: {
            // Fallback only: the command's own `mergedMessage` result names the method Server Core chose.
            success: l10n.t('Merged #{number}', { number: pullRequest.number }),
            failure: l10n.t("Couldn't merge #{number}", { number: pullRequest.number }),
            githubUrl: pullRequest.url,
        },
    };
}

/**
 * The PR row's inline buttons. Failed checks put the Agent's labeled `Fix` first, as the next step, and keep the red
 * merge glyph after it for a deliberate `Merge Anyway`; every other state shows the merge button alone (a conflict's
 * `Resolve` takes its place inside {@link mergePullRequestAction}).
 */
export function pullRequestRowActions(
    repo: Pick<ProjectStatusRepository, 'branch' | 'defaultBranch' | 'id' | 'kind' | 'name'>,
    pullRequest: PullRequest,
): TreeItemAction[] | undefined {
    const merge = mergePullRequestAction(repo, pullRequest);
    const fix =
        pullRequest.lifecycle === 'open' && pullRequest.mergeBlocker === 'checks-failed'
            ? fixFailedChecksAction(repo, pullRequest)
            : undefined;
    const actions = [fix, merge].filter((action) => action !== undefined);
    return actions.length > 0 ? actions : undefined;
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
        return { kind: 'refuse', message: l10n.t('The current branch has no pull request.') };
    const { number } = pullRequest;
    if (pullRequest.lifecycle === 'draft')
        return {
            kind: 'refuse',
            message: l10n.t(
                'Pull request #{number} is a draft. Mark it ready for review on GitHub first.',
                { number },
            ),
        };
    if (pullRequest.lifecycle !== 'open')
        return {
            kind: 'refuse',
            message:
                pullRequest.lifecycle === 'merged'
                    ? l10n.t('Pull request #{number} is merged, so there is nothing to merge.', {
                          number,
                      })
                    : pullRequest.lifecycle === 'closed'
                      ? l10n.t('Pull request #{number} is closed, so there is nothing to merge.', {
                            number,
                        })
                      : l10n.t(
                            'Pull request #{number} is not open, so there is nothing to merge.',
                            {
                                number,
                            },
                        ),
        };
    const blocker = pullRequest.mergeBlocker;
    if (blocker === 'conflicting')
        return {
            kind: 'refuse',
            message: l10n.t(
                'Pull request #{number} has conflicts. Use Resolve in the Status panel to have the Agent rebase it.',
                { number },
            ),
        };
    if (blocker)
        return {
            kind: 'refuse',
            message: l10n.t(
                'Pull request #{number} is not ready to merge: {reason}. Use the merge button in the Status panel to merge it anyway.',
                { number, reason: mergeBlockerLabels[blocker]().toLowerCase() },
            ),
        };
    if (!pullRequest.headSha)
        return {
            kind: 'refuse',
            message: l10n.t(
                'Pull request #{number} has no known head commit yet. Refresh Project Status and try again.',
                { number },
            ),
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

/**
 * Success toast text naming the merge method Server Core picked, which is only known once the merge has happened.
 */
export function mergedMessage(method: MergeMethod, number: number): string {
    if (method === 'squash') return l10n.t('Squash-merged #{number}', { number });
    return method === 'merge'
        ? l10n.t('Merged #{number}', { number })
        : l10n.t('Rebase-merged #{number}', { number });
}
