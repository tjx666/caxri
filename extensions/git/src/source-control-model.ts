import type {
    GitCommitDetails,
    GitFileStatus,
    GitPullRequestChanges,
    GitRepositorySummary,
    GitSummary,
    SourceControlAction,
    SourceControlCommandBinding,
    SourceControlFileHistory,
    SourceControlResource,
    SourceControlViewModel,
} from 'caxri';
import { isGlobMatch, l10n, ProjectStatusSummaryErrorMessage } from 'caxri';

import { branchSync } from './branch-sync';
import { commitFilesToStatuses } from './commit-file-statuses';
import { formatRepoCountLabel, repoBranchRow as repoBranchRow } from './repo-row-labels';
import { emptyStateForMode } from './source-control-empty-state';
import {
    excludedFilesToggleLabel,
    hiddenFilesMessage,
    historyDescriptor,
    repoKindLabel,
    sourceControlModes,
    summaryErrorMessage,
    themeIcon,
    uncommittedChangesLabel,
    uncommittedChangesTooltip,
} from './source-control-labels';
import {
    boundedActionLabel,
    boundedEditorResource,
    boundedSourceControlDescription,
    sourceControlLineStats,
    sourceControlResourceProjection,
} from './source-control-projection';
import { boundedSourceControlResourceId } from './source-control-resource-id';
import { hiddenGitlinkPaths, visibleChangedFileCount } from './submodule-sections';

export type GitSourceControlMode = 'commit' | 'pull-request' | 'working';

export interface ActionRegistration {
    accessibilityLabel?: string;
    command: SourceControlCommandBinding;
    disabled?: boolean;
    icon: SourceControlAction['icon'];
    label: string;
    progressLabel?: string;
    pressed?: boolean;
    emphasis?: 'danger';
    errorMessage?: string;
    tooltip?: string;
}

export type RegisterSourceControlAction = (action: ActionRegistration) => SourceControlAction;

interface BuildSourceControlViewModelOptions {
    activeResource?: string;
    detailsByRepository?: ReadonlyMap<string, GitCommitDetails>;
    detailErrorsByRepository?: ReadonlyMap<string, true | string>;
    mode: GitSourceControlMode;
    pullRequestsByRepository?: ReadonlyMap<string, GitPullRequestChanges | null>;
    registerAction?: RegisterSourceControlAction;
    revision?: string;
    selectedCommitSha?: string;
    summary: GitSummary;
    fileHistoryRepositories?: readonly GitRepositorySummary[];
    excludePatterns?: Readonly<Record<string, boolean>>;
    isShowingExcluded?: boolean;
}

/**
 * VS Code's own Source Control glyphs, by repository kind: `repo` for a checkout, `worktree` for a linked worktree (the
 * arrow splitting off a trunk), and `archive` for a submodule. A nested repository is an ordinary checkout that happens
 * to live inside another, so it shares `repo` and is distinguished by its `kindLabel`.
 */
const repoKindIcons: Record<GitRepositorySummary['kind'], string> = {
    primary: 'repo',
    worktree: 'worktree',
    nested: 'repo',
    submodule: 'archive',
};

function fallbackRegisterAction(action: ActionRegistration): SourceControlAction {
    return { id: action.command.id, ...action };
}

function basename(path: string): string {
    return path.split('/').findLast(Boolean) ?? path;
}

function trimTrailingPathSeparators(path: string): string {
    return path === '/' ? path : path.replace(/\/+$/, '');
}

/**
 * Performs only lexical selection because product extensions cannot import Node path APIs. It preserves backslashes,
 * which are valid macOS filename characters. Git Runtime revalidates the repository and relative path before reading
 * history, so this helper never acts as the security boundary.
 */
function relativeFilePath(rootPath: string, resource: string): string | undefined {
    const root = trimTrailingPathSeparators(rootPath);
    const candidate = trimTrailingPathSeparators(resource);
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (!root || !candidate.startsWith(prefix)) return;
    const path = candidate.slice(prefix.length);
    return path.length <= 4_096 ? path : undefined;
}

/**
 * Associates the active file with the deepest discovered repository so a nested repository owns its own file history
 * instead of leaking through the outer repository's path scope.
 */
function fileHistoryModel(
    activeResource: string | undefined,
    repositories: readonly GitRepositorySummary[],
    revision: string,
): SourceControlFileHistory | undefined {
    const match = activeResource
        ? repositories
              .map((repo) => ({ path: relativeFilePath(repo.rootPath, activeResource), repo }))
              .filter(
                  (candidate): candidate is { path: string; repo: GitRepositorySummary } =>
                      candidate.path !== undefined,
              )
              .toSorted((left, right) => right.repo.rootPath.length - left.repo.rootPath.length)[0]
        : undefined;
    if (!match) return;
    return {
        label: l10n.t('File History'),
        emptyMessage: l10n.t('Open a file to view its history.'),
        history: historyDescriptor(match.repo, revision, 'file'),
        description: basename(match.path),
        path: match.path,
        tooltip: match.path,
    };
}

function decoration(file: GitFileStatus): SourceControlResource['decoration'] {
    const label = file.index === ' ' ? file.workingTree : file.index;
    const tone =
        file.kind === 'added' || file.kind === 'untracked'
            ? 'success'
            : file.kind === 'deleted' || file.kind === 'conflicted'
              ? 'danger'
              : 'warning';
    return { identifier: file.kind, label, tone };
}

function editorResource(
    mode: GitSourceControlMode,
    repoId: string,
    path: string,
    head?: string,
): string | undefined {
    const encodedRepo = encodeURIComponent(repoId);
    const encodedPath = encodeURIComponent(path);
    if (mode === 'working') return `caxri-git-diff://file/${encodedRepo}/${encodedPath}`;
    if (mode === 'pull-request') return `caxri-git-diff://pr-file/${encodedRepo}/${encodedPath}`;
    return head ? `caxri-git-diff://commit-file/${encodedRepo}/${head}/${encodedPath}` : undefined;
}

function aggregateEditorResource(
    mode: GitSourceControlMode,
    repoId: string,
    repoName: string,
    isShowingExcluded: boolean,
): string | undefined {
    if (mode === 'commit') return undefined;
    const resource = `caxri-git-diff://${mode === 'pull-request' ? 'pr-changes' : 'changes'}/${encodeURIComponent(repoId)}/${encodeURIComponent(repoName)}`;
    return isShowingExcluded ? `${resource}?showExcluded=true` : resource;
}

function excludedFileCount(
    files: readonly GitFileStatus[],
    excludePatterns: Readonly<Record<string, boolean>>,
): number {
    return files.filter((file) => isGlobMatch(file.path, excludePatterns)).length;
}

function resourcesForRepo(
    mode: GitSourceControlMode,
    repo: GitRepositorySummary,
    files: GitFileStatus[],
    commitSha: string | undefined,
    registerAction: RegisterSourceControlAction,
): SourceControlResource[] {
    return files.map((file) => {
        const rawResource = editorResource(mode, repo.id, file.path, commitSha ?? repo.head);
        const resource = rawResource ? boundedEditorResource(rawResource) : undefined;
        const projection = sourceControlResourceProjection(file.path);
        return {
            id: boundedSourceControlResourceId(repo.id, file.path),
            label: projection.label,
            description: decoration(file)?.label,
            tooltip: projection.tooltip,
            accessibilityLabel: projection.accessibilityLabel,
            icon: { kind: 'file-type' as const, name: projection.label },
            path: projection.path,
            decoration: decoration(file),
            ...sourceControlLineStats(file),
            ...(resource && { editorResource: resource }),
            ...(resource !== undefined && {
                action: registerAction({
                    command: {
                        id: 'caxri.git.openChanges',
                        arguments: [resource],
                    },
                    icon: themeIcon('diff'),
                    label: boundedActionLabel(
                        l10n.t('Open changes in {path}', { path: file.path }),
                    ),
                }),
            }),
            ...(mode === 'working' && {
                actions: [
                    registerAction({
                        command: {
                            id: 'caxri.git.discard',
                            arguments: [repo.id, file.path],
                        },
                        icon: themeIcon('discard'),
                        emphasis: 'danger',
                        errorMessage: l10n.t('Discard failed'),
                        label:
                            file.kind === 'untracked'
                                ? l10n.t('Delete File')
                                : l10n.t('Discard Changes'),
                        accessibilityLabel:
                            file.kind === 'untracked'
                                ? l10n.t('Delete {name}', { name: basename(file.path) })
                                : l10n.t('Discard changes in {name}', {
                                      name: basename(file.path),
                                  }),
                    }),
                ],
            }),
        };
    });
}

/**
 * The raw change list a repository contributes in the selected mode, before the submodule and exclusion filters.
 */
function repoFiles(
    mode: GitSourceControlMode,
    repo: GitRepositorySummary,
    details: GitCommitDetails | undefined,
    pullRequest: GitPullRequestChanges | null | undefined,
): readonly GitFileStatus[] {
    if (mode === 'working') return repo.files;
    return mode === 'commit' ? commitFilesToStatuses(details) : (pullRequest?.files ?? []);
}

export function buildSourceControlViewModel({
    activeResource,
    detailsByRepository: detailsByRepo = new Map(),
    detailErrorsByRepository: detailErrorsByRepo = new Map(),
    mode,
    pullRequestsByRepository: pullRequestsByRepo = new Map(),
    registerAction = fallbackRegisterAction,
    revision = '0',
    selectedCommitSha,
    summary,
    fileHistoryRepositories = summary.repositories,
    excludePatterns = {},
    isShowingExcluded = false,
}: BuildSourceControlViewModelOptions): SourceControlViewModel {
    const emptyMessage = !summary.isRepository
        ? summaryErrorMessage(summary.error)
        : summary.repositories.length === 0
          ? l10n.t('No approved Git repositories found.')
          : undefined;
    const emptyKind = emptyMessage
        ? summary.error === ProjectStatusSummaryErrorMessage.missingGitRepository
            ? 'no-repository'
            : 'unavailable'
        : undefined;
    const fileHistory = summary.isRepository
        ? fileHistoryModel(activeResource, fileHistoryRepositories, revision)
        : undefined;
    const excludedCount = summary.repositories.reduce((total, repo) => {
        const submodulePaths = hiddenGitlinkPaths(mode, repo, summary.repositories);
        const files = repoFiles(
            mode,
            repo,
            detailsByRepo.get(repo.id),
            pullRequestsByRepo.get(repo.id),
        ).filter((file) => !submodulePaths.has(file.path));
        return total + excludedFileCount(files, excludePatterns);
    }, 0);
    const hasEnabledExclusions = Object.entries(excludePatterns).some(
        ([pattern, enabled]) => enabled && pattern.trim() !== '',
    );
    /**
     * Repository-level `hasUnloadedExclusions` (below) decides whether one repository may discard everything; the
     * header toggle is panel-wide, so it asks the same question across every repository at once. Any truncated
     * repository can still be hiding excluded files in its unloaded tail even when every loaded path is visible.
     */
    const hasAnyUnloadedExclusions =
        !isShowingExcluded &&
        hasEnabledExclusions &&
        summary.repositories.some((repo) => repo.truncated === true);
    /**
     * A configured pattern is not by itself something to reveal: matching nothing left `Show excluded files (0)` on the
     * caption permanently, promising a change it could not make. The toggle appears only when it would actually change
     * what the panel shows, or when it is the way back out of the shown state.
     */
    const hasActionableExclusions =
        hasEnabledExclusions &&
        (excludedCount > 0 || isShowingExcluded || hasAnyUnloadedExclusions);
    return {
        revision,
        title: l10n.t('Source Control'),
        accessibilityLabel: l10n.t('Git repositories'),
        modeAccessibilityLabel: l10n.t('Source control mode'),
        modes: [...sourceControlModes(selectedCommitSha)],
        selectedModeId: mode,
        refreshAction: registerAction({
            command: { id: 'caxri.git.refresh' },
            icon: themeIcon('refresh'),
            label: mode === 'pull-request' ? l10n.t('Refresh Pull Request') : l10n.t('Refresh Git'),
        }),
        ...(hasActionableExclusions && {
            headerActions: [
                registerAction({
                    command: { id: 'caxri.git.toggleExcludedFiles' },
                    icon: themeIcon(isShowingExcluded ? 'eye-off' : 'eye'),
                    label: excludedFilesToggleLabel(isShowingExcluded, excludedCount),
                    pressed: isShowingExcluded,
                    tooltip: excludedFilesToggleLabel(isShowingExcluded, excludedCount),
                }),
            ],
        }),
        ...(fileHistory && { fileHistory }),
        providers: summary.repositories.map((repo) => {
            const details = detailsByRepo.get(repo.id);
            const pullRequest = pullRequestsByRepo.get(repo.id);
            const submodulePaths = hiddenGitlinkPaths(mode, repo, summary.repositories);
            const workingCount = visibleChangedFileCount(repo, summary);
            const modeFiles = repoFiles(mode, repo, details, pullRequest);
            const files = modeFiles.filter((file) => !submodulePaths.has(file.path));
            const repoExcludedCount = excludedFileCount(files, excludePatterns);
            const visibleFiles = isShowingExcluded
                ? files
                : files.filter((file) => !isGlobMatch(file.path, excludePatterns));
            const hiddenCount = isShowingExcluded ? 0 : repoExcludedCount;
            /**
             * The unloaded tail may contain excluded files even when every loaded path is visible.
             */
            const hasUnloadedExclusions =
                !isShowingExcluded && hasEnabledExclusions && repo.truncated === true;
            const isDiscardBlockedByExclusions = hiddenCount > 0 || hasUnloadedExclusions;
            /**
             * `changedFileCount` is the Server's untruncated total, so the submodule rows this list drops are
             * subtracted from it directly; the other modes count the filtered list they render.
             */
            const count = mode === 'working' ? workingCount : files.length;
            /**
             * Commit and Pull Request mode replace the file list with that commit's or that pull request's files, so a
             * repository holding uncommitted work looks exactly like a clean one: the user only finds out by switching
             * modes. State the count on the repository row and make it the way back to it.
             */
            const uncommittedCount = mode === 'working' ? 0 : workingCount;
            const branchRow = repoBranchRow(repo);
            const sync = branchSync(mode, repo, branchRow, registerAction);
            /**
             * Omitted when both are zero: `0 ahead, 0 behind` is the steady state and told the hover's reader nothing.
             */
            const aheadBehindLabel =
                repo.ahead > 0 || repo.behind > 0
                    ? `${l10n.t('{count} ahead', { count: repo.ahead })}, ${l10n.t('{count} behind', { count: repo.behind })}`
                    : undefined;
            const revisionSummary = pullRequest
                ? l10n.t('Pull request #{number} into {base}: {title}', {
                      number: pullRequest.number,
                      base: pullRequest.baseRefName,
                      title: pullRequest.title,
                  })
                : details
                  ? `${details.commit.shortSha} ${details.commit.subject}`
                  : undefined;
            const unpushedCommitCount =
                mode === 'pull-request' ? (pullRequest?.unpushedCommitCount ?? 0) : 0;
            const unpushedSummary =
                pullRequest && unpushedCommitCount > 0
                    ? unpushedCommitCount === 1
                        ? l10n.t('{count} local commit is not included in pull request #{number}', {
                              count: unpushedCommitCount,
                              number: pullRequest.number,
                          })
                        : l10n.t(
                              '{count} local commits are not included in pull request #{number}',
                              { count: unpushedCommitCount, number: pullRequest.number },
                          )
                    : undefined;
            const trackingSummary = repo.upstream
                ? l10n.t('tracking {ref}', { ref: repo.upstream })
                : undefined;
            const hoverParts = [
                branchRow.summary,
                trackingSummary,
                aheadBehindLabel,
                revisionSummary,
                unpushedSummary,
            ].filter(Boolean);
            const descriptionAccessibilityLabel = boundedSourceControlDescription(
                hoverParts.join(', '),
            );
            const descriptionTooltip = boundedSourceControlDescription(hoverParts.join(' · '));
            const groupLabel = pullRequest
                ? l10n.t('PR #{number} Changes', { number: pullRequest.number })
                : mode === 'commit'
                  ? details
                      ? l10n.t('Commit {sha}', { sha: details.commit.shortSha })
                      : l10n.t('Last Commit')
                  : // A repository with no pull request still sits in Pull Request mode. Leaving the heading at
                    // `Changes` made its zero read as "the working tree is clean" instead of "no pull request here".
                    mode === 'pull-request'
                    ? l10n.t('Pull Request Changes')
                    : l10n.t('Changes');
            const actions: SourceControlAction[] = [];
            const aggregateResource = aggregateEditorResource(
                mode,
                repo.id,
                repo.name,
                isShowingExcluded,
            );
            if (mode === 'working')
                actions.push(
                    registerAction({
                        command: {
                            id: 'caxri.git.discardAll',
                            arguments: [repo.id, isDiscardBlockedByExclusions],
                        },
                        disabled: repo.changedFileCount === 0 || isDiscardBlockedByExclusions,
                        icon: themeIcon('discard'),
                        emphasis: 'danger',
                        errorMessage: l10n.t('Discard failed'),
                        label: l10n.t('Discard All Changes'),
                        ...(isDiscardBlockedByExclusions && {
                            tooltip: hasUnloadedExclusions
                                ? l10n.t(
                                      'Some changes are not loaded. Show excluded files before discarding all changes.',
                                  )
                                : l10n.t('Show excluded files to discard all changes.'),
                        }),
                    }),
                );
            if (mode !== 'commit')
                actions.push(
                    registerAction({
                        command: {
                            id: 'caxri.git.openChanges',
                            arguments: [aggregateResource],
                        },
                        disabled: visibleFiles.length === 0,
                        icon: themeIcon('diff-multiple'),
                        label:
                            mode === 'pull-request'
                                ? l10n.t('Open Pull Request Changes')
                                : l10n.t('Open Working Tree Changes'),
                        accessibilityLabel:
                            mode === 'pull-request'
                                ? l10n.t('Open Pull Request Changes')
                                : l10n.t('Open Changes'),
                    }),
                );
            return {
                id: repo.id,
                label: repo.name,
                ...(repo.kind !== 'primary' && { kindLabel: repoKindLabel(repo.kind) }),
                icon: themeIcon(repoKindIcons[repo.kind]),
                tooltip: repo.rootPath,
                rootPath: repo.rootPath,
                description: branchRow.description,
                descriptionKind: branchRow.kind,
                ...(branchRow.badge && { descriptionBadge: branchRow.badge }),
                ...(sync.badgeActionId && { descriptionBadgeActionId: sync.badgeActionId }),
                descriptionAccessibilityLabel,
                descriptionTooltip,
                ...(pullRequest && {
                    externalLink: {
                        url: pullRequest.url,
                        label: boundedActionLabel(
                            l10n.t('Open pull request #{number} on the web', {
                                number: pullRequest.number,
                            }),
                        ),
                    },
                }),
                countLabel:
                    mode === 'pull-request' && detailErrorsByRepo.has(repo.id)
                        ? ` · ${l10n.t('Unavailable')}`
                        : formatRepoCountLabel({
                              count,
                              uncommittedCount,
                              unpushedCommitCount,
                          }),
                ...(uncommittedCount > 0 && {
                    uncommittedNotice: {
                        modeId: 'working',
                        accessibilityLabel: uncommittedChangesLabel(uncommittedCount, repo.name),
                        tooltip: uncommittedChangesTooltip(uncommittedCount, repo.name),
                    },
                }),
                expandedByDefault: true,
                actions: sync.action ? [sync.action] : [],
                groups: [
                    {
                        id: `${repo.id}:changes`,
                        label: groupLabel,
                        count,
                        ...(hiddenCount > 0 && { hiddenCount }),
                        expandedByDefault: true,
                        ...(visibleFiles.length === 0 && hiddenCount > 0
                            ? { emptyMessage: hiddenFilesMessage(hiddenCount) }
                            : emptyStateForMode(
                                  mode,
                                  repo,
                                  details,
                                  detailErrorsByRepo.get(repo.id),
                                  pullRequest,
                                  selectedCommitSha,
                              )),
                        ...(mode === 'working' &&
                            repo.truncated && {
                                truncationMessage: l10n.t(
                                    'Showing the first {shown} of {total} changes',
                                    {
                                        shown: files.length,
                                        total: count,
                                    },
                                ),
                            }),
                        ...(mode === 'commit' &&
                            details?.filesTruncated && {
                                truncationMessage: l10n.t(
                                    'Showing the first {count} files of this commit',
                                    {
                                        count: files.length,
                                    },
                                ),
                            }),
                        actions,
                        resources: resourcesForRepo(
                            mode,
                            repo,
                            visibleFiles,
                            details?.commit.sha,
                            registerAction,
                        ),
                    },
                ],
                ...(mode === 'working' && {
                    history: historyDescriptor(repo, revision, 'repository'),
                }),
            };
        }),
        ...(emptyMessage && { emptyMessage, emptyKind }),
    };
}

/**
 * Joins a repository row's trailing counts, omitting every zero part: a synced, clean repository shows no `↑0 ↓0 · 0`
 * noise, only the parts that ask for attention.
 */
