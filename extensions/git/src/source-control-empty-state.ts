import type {
    GitCommitDetails,
    GitPullRequestChanges,
    GitRepositorySummary,
    SourceControlGroup,
} from 'caxri';
import { l10n } from 'caxri';

import { canDetectPullRequest } from './pull-request-detection';
import type { GitSourceControlMode } from './source-control-model';

function loading(emptyMessage: string): Pick<SourceControlGroup, 'emptyMessage' | 'isLoading'> {
    return { emptyMessage, isLoading: true };
}

/**
 * Appends the recovery step to a failed pull request lookup. The lookup is not retried on its own, so the caption names
 * the panel's Refresh action instead of leaving a dead end; the provider's message may or may not end in a period.
 */
export function withRetryHint(message: string): string {
    const trimmed = message.trim();
    // A safe provider message may already name the step (`... Check remote access and refresh.`); say it once.
    if (/\brefresh\b/i.test(trimmed)) return trimmed;
    return `${/[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`} ${l10n.t('Refresh to retry.')}`;
}

/**
 * The group body shown when a repository contributes no visible rows. `isLoading` marks the states that will resolve on
 * their own, so the Workbench can draw a progress glyph instead of a caption that reads like a settled empty result.
 */
export function emptyStateForMode(
    mode: GitSourceControlMode,
    repo: GitRepositorySummary,
    details: GitCommitDetails | undefined,
    detailError: true | string | undefined,
    pullRequest: GitPullRequestChanges | null | undefined,
    selectedCommitSha?: string,
): Pick<SourceControlGroup, 'emptyMessage' | 'isLoading'> {
    if (mode === 'working') return { emptyMessage: l10n.t('Working tree clean.') };
    if (mode === 'commit') {
        if (!repo.head) return { emptyMessage: l10n.t('No commits yet.') };
        if (detailError)
            return {
                emptyMessage: selectedCommitSha
                    ? l10n.t('Unable to load commit {sha}.', { sha: selectedCommitSha.slice(0, 7) })
                    : l10n.t('Unable to load the last commit.'),
            };
        if (selectedCommitSha)
            return details
                ? {
                      emptyMessage: l10n.t('Commit {sha} has no file changes.', {
                          sha: selectedCommitSha.slice(0, 7),
                      }),
                  }
                : loading(l10n.t('Loading commit {sha}…', { sha: selectedCommitSha.slice(0, 7) }));
        return details
            ? { emptyMessage: l10n.t('Last commit has no file changes.') }
            : loading(l10n.t('Loading last commit…'));
    }
    // A detached HEAD has no branch to match, so the provider skips the lookup and this says why nothing is listed.
    if (!canDetectPullRequest(repo))
        return {
            emptyMessage: l10n.t(
                'Detached HEAD has no pull request. Switch to a branch to see one.',
            ),
        };
    if (detailError)
        return {
            emptyMessage:
                typeof detailError === 'string'
                    ? withRetryHint(detailError)
                    : l10n.t('Unable to load pull request changes. Refresh to retry.'),
        };
    if (pullRequest === null) return { emptyMessage: l10n.t('No pull request for this branch.') };
    return pullRequest
        ? { emptyMessage: l10n.t('Pull request has no file changes.') }
        : loading(l10n.t('Loading pull request changes…'));
}
