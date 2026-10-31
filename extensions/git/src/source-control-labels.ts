import type { GitRepositorySummary, SourceControlHistoryDescriptor } from 'caxri';
import { l10n, ProjectStatusSummaryErrorMessage } from 'caxri';

export function themeIcon(id: string) {
    return { kind: 'theme' as const, id };
}

export function sourceControlModes(selectedCommitSha?: string) {
    return [
        {
            command: { id: 'caxri.git.workingTree' },
            icon: themeIcon('diff'),
            id: 'working',
            label: l10n.t('Working Tree Changes'),
        },
        {
            command: { id: 'caxri.git.lastCommit' },
            icon: themeIcon('git-commit'),
            id: 'commit',
            label: selectedCommitSha
                ? l10n.t('Commit Changes ({sha})', { sha: selectedCommitSha.slice(0, 7) })
                : l10n.t('Last Commit Changes'),
        },
        {
            command: { id: 'caxri.git.pullRequest' },
            icon: themeIcon('git-pull-request'),
            id: 'pull-request',
            label: l10n.t('Pull Request Changes'),
        },
    ] as const;
}

/**
 * Names the uncommitted work a non-working mode is hiding, for both the button's accessible name and its tooltip.
 */
export function uncommittedChangesLabel(count: number, repoName: string): string {
    return count === 1
        ? l10n.t('{count} uncommitted change in {name}', { count, name: repoName })
        : l10n.t('{count} uncommitted changes in {name}', { count, name: repoName });
}

export function uncommittedChangesTooltip(count: number, repoName: string): string {
    return count === 1
        ? l10n.t('{count} uncommitted change in {name}. Show Working Tree Changes.', {
              count,
              name: repoName,
          })
        : l10n.t('{count} uncommitted changes in {name}. Show Working Tree Changes.', {
              count,
              name: repoName,
          });
}

export function excludedFilesToggleLabel(isShowingExcluded: boolean, count: number): string {
    return isShowingExcluded
        ? l10n.t('Hide excluded files ({count})', { count })
        : l10n.t('Show excluded files ({count})', { count });
}

/**
 * The tag beside a non-primary repository's name. Called per build so it follows the interface language.
 */
export function repoKindLabel(kind: Exclude<GitRepositorySummary['kind'], 'primary'>): string {
    if (kind === 'worktree') return l10n.t('worktree');
    return kind === 'nested' ? l10n.t('nested') : l10n.t('submodule');
}

export function historyDescriptor(
    repo: GitRepositorySummary,
    revision: string,
    kind: 'file' | 'repository',
): SourceControlHistoryDescriptor {
    return {
        id: repo.id,
        label: kind === 'file' ? l10n.t('File History') : l10n.t('Commits'),
        command: {
            id: 'caxri.git.history',
            arguments: [repo.id],
        },
        pathInputLabel: l10n.t('History path for {name}', { name: repo.name }),
        pathInputPlaceholder: l10n.t('History path (optional)'),
        clearPathLabel: l10n.t('Clear history path'),
        loadingMessage:
            kind === 'file' ? l10n.t('Loading file history…') : l10n.t('Loading commits…'),
        emptyMessage: kind === 'file' ? l10n.t('No file history.') : l10n.t('No commits.'),
        loadMoreLabel: l10n.t('Load more commits'),
        loadingMoreLabel: l10n.t('Loading…'),
        loadErrorMessage:
            kind === 'file'
                ? l10n.t('Unable to load file history')
                : l10n.t('Unable to load commits'),
        detailsLoadingMessage: l10n.t('Loading commit…'),
        detailsErrorMessage: l10n.t('Unable to load commit'),
        detailsLabel: l10n.t('Changed files'),
        detailsEmptyMessage: l10n.t('No files in this scope.'),
        detailsTruncatedMessage: l10n.t('File list truncated.'),
        itemAccessibilityLabelPrefix: l10n.t('Commit'),
        ...(kind === 'file' && { itemActivation: 'action' as const }),
        pageSize: 5,
        revision,
    };
}

export function hiddenFilesMessage(hiddenCount: number): string {
    return hiddenCount === 1
        ? l10n.t('{count} excluded file hidden.', { count: hiddenCount })
        : l10n.t('{count} excluded files hidden.', { count: hiddenCount });
}

export function summaryErrorMessage(error: string | undefined): string {
    if (error === ProjectStatusSummaryErrorMessage.missingGitRepository)
        return l10n.t('This folder is not a Git repository.');
    return error
        ? l10n.t('Source Control is unavailable right now. {error}', { error })
        : l10n.t('Source Control is unavailable right now.');
}

/**
 * The toast after Sync Changes, from the counts before it ran.
 */
export function syncResultMessage(ahead: number, behind: number): string {
    return ahead === 0 && behind === 0
        ? l10n.t('Already up to date')
        : l10n.t('Synced with remote');
}
