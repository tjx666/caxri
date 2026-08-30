import type {
    GitCommitDetails,
    GitFileStatus,
    GitPullRequestChanges,
    GitRepositorySummary,
    GitSummary,
    SourceControlAction,
    SourceControlCommandBinding,
    SourceControlFileHistory,
    SourceControlHistoryDescriptor,
    SourceControlResource,
    SourceControlViewModel,
} from 'caxri';
import { ProjectStatusSummaryErrorMessage } from 'caxri';

import {
    boundedActionLabel,
    boundedEditorResource,
    sourceControlResourceProjection,
} from './source-control-projection';
import { boundedSourceControlResourceId } from './source-control-resource-id';

export type GitSourceControlMode = 'commit' | 'pull-request' | 'working';

export interface ActionRegistration {
    accessibilityLabel?: string;
    command: SourceControlCommandBinding;
    disabled?: boolean;
    icon: SourceControlAction['icon'];
    label: string;
    progressLabel?: string;
    emphasis?: 'danger';
    errorMessage?: string;
    tooltip?: string;
}

export type RegisterSourceControlAction = (action: ActionRegistration) => SourceControlAction;

interface BuildSourceControlViewModelOptions {
    activeResource?: string;
    detailsByRepository?: ReadonlyMap<string, GitCommitDetails>;
    detailErrorsByRepository?: ReadonlyMap<string, true>;
    mode: GitSourceControlMode;
    pullRequestsByRepository?: ReadonlyMap<string, GitPullRequestChanges | null>;
    registerAction?: RegisterSourceControlAction;
    revision?: string;
    selectedCommitSha?: string;
    summary: GitSummary;
    fileHistoryRepositories?: readonly GitRepositorySummary[];
}

function themeIcon(id: string) {
    return { kind: 'theme' as const, id };
}

function sourceControlModes(selectedCommitSha?: string) {
    return [
        {
            command: { id: 'caxri.git.workingTree' },
            icon: themeIcon('diff'),
            id: 'working',
            label: 'Working Tree Changes',
        },
        {
            command: { id: 'caxri.git.lastCommit' },
            icon: themeIcon('git-commit'),
            id: 'commit',
            label: selectedCommitSha
                ? `Commit Changes (${selectedCommitSha.slice(0, 7)})`
                : 'Last Commit Changes',
        },
        {
            command: { id: 'caxri.git.pullRequest' },
            icon: themeIcon('git-pull-request'),
            id: 'pull-request',
            label: 'Pull Request Changes',
        },
    ] as const;
}

function fallbackRegisterAction(action: ActionRegistration): SourceControlAction {
    return { id: action.command.id, ...action };
}

function basename(path: string): string {
    return path.split('/').findLast(Boolean) ?? path;
}

function normalizeRepoPath(path: string): string {
    const normalized = path.replaceAll('\\', '/');
    return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

function trimTrailingPathSeparators(path: string): string {
    return path === '/' ? path : path.replace(/\/+$/, '');
}

function historyDescriptor(
    repo: GitRepositorySummary,
    revision: string,
    kind: 'file' | 'repository',
): SourceControlHistoryDescriptor {
    return {
        id: repo.id,
        label: kind === 'file' ? 'File History' : 'Commits',
        command: {
            id: 'caxri.git.history',
            arguments: [repo.id],
        },
        pathInputLabel: `History path for ${repo.name}`,
        pathInputPlaceholder: 'History path (optional)',
        clearPathLabel: 'Clear history path',
        loadingMessage: kind === 'file' ? 'Loading file history…' : 'Loading commits…',
        emptyMessage: kind === 'file' ? 'No file history.' : 'No commits.',
        loadMoreLabel: 'Load more commits',
        loadingMoreLabel: 'Loading…',
        loadErrorMessage:
            kind === 'file' ? 'Unable to load file history' : 'Unable to load commits',
        detailsLoadingMessage: 'Loading commit…',
        detailsErrorMessage: 'Unable to load commit',
        detailsLabel: 'Changed files',
        detailsEmptyMessage: 'No files in this scope.',
        detailsTruncatedMessage: 'File list truncated.',
        itemAccessibilityLabelPrefix: 'Commit',
        ...(kind === 'file' && { itemActivation: 'action' as const }),
        pageSize: 5,
        revision,
    };
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
    const fallback = repositories.at(0);
    if (!fallback) return;
    const match = activeResource
        ? repositories
              .map((repo) => ({ path: relativeFilePath(repo.rootPath, activeResource), repo }))
              .filter(
                  (candidate): candidate is { path: string; repo: GitRepositorySummary } =>
                      candidate.path !== undefined,
              )
              .toSorted((left, right) => right.repo.rootPath.length - left.repo.rootPath.length)[0]
        : undefined;
    const repo = match?.repo ?? fallback;
    return {
        label: 'File History',
        emptyMessage: 'Open a file to view its history.',
        history: historyDescriptor(repo, revision, 'file'),
        ...(match && {
            description: basename(match.path),
            path: match.path,
            tooltip: match.path,
        }),
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
): string | undefined {
    if (mode === 'commit') return undefined;
    return `caxri-git-diff://${mode === 'pull-request' ? 'pr-changes' : 'changes'}/${encodeURIComponent(repoId)}/${encodeURIComponent(repoName)}`;
}

function commitFilesToStatuses(details: GitCommitDetails | undefined): GitFileStatus[] {
    const status = {
        'modified': { kind: 'modified', letter: 'M' },
        'added': { kind: 'added', letter: 'A' },
        'deleted': { kind: 'deleted', letter: 'D' },
        'renamed': { kind: 'renamed', letter: 'R' },
        'copied': { kind: 'added', letter: 'C' },
        'type-changed': { kind: 'modified', letter: 'T' },
        'unknown': { kind: 'modified', letter: '?' },
    } as const;
    return (details?.files ?? []).map((file) => ({
        path: file.path,
        ...(file.previousPath && { originalPath: file.previousPath }),
        index: status[file.status].letter,
        workingTree: ' ',
        kind: status[file.status].kind,
    }));
}

function submoduleIdsByPath(
    repo: GitRepositorySummary,
    repositories: readonly GitRepositorySummary[],
): ReadonlyMap<string, string> {
    const root = normalizeRepoPath(repo.rootPath);
    const result = new Map<string, string>();
    for (const candidate of repositories) {
        if (candidate.kind !== 'submodule' || candidate.id === repo.id) continue;
        const candidateRoot = normalizeRepoPath(candidate.rootPath);
        if (candidateRoot.startsWith(`${root}/`))
            result.set(candidateRoot.slice(root.length + 1), candidate.id);
    }
    return result;
}

function resourcesForRepo(
    mode: GitSourceControlMode,
    repo: GitRepositorySummary,
    repositories: readonly GitRepositorySummary[],
    files: GitFileStatus[],
    commitSha: string | undefined,
    registerAction: RegisterSourceControlAction,
): SourceControlResource[] {
    const submodules = submoduleIdsByPath(repo, repositories);
    return files.map((file) => {
        const submoduleId = submodules.get(file.path);
        const rawResource = editorResource(mode, repo.id, file.path, commitSha ?? repo.head);
        const resource = rawResource ? boundedEditorResource(rawResource) : undefined;
        const projection = sourceControlResourceProjection(file.path);
        const commandId = submoduleId ? 'caxri.git.openSubmodule' : 'caxri.git.openChanges';
        return {
            id: boundedSourceControlResourceId(repo.id, file.path),
            label: projection.label,
            description: submoduleId ? 'submodule' : decoration(file)?.label,
            tooltip: submoduleId
                ? boundedActionLabel(`Toggle the ${basename(file.path)} submodule repository`)
                : projection.tooltip,
            accessibilityLabel: submoduleId
                ? boundedActionLabel(`Toggle the ${basename(file.path)} submodule repository`)
                : projection.accessibilityLabel,
            icon: submoduleId
                ? themeIcon('file-submodule')
                : { kind: 'file-type' as const, name: projection.label },
            path: projection.path,
            decoration: decoration(file),
            ...(resource && { editorResource: resource }),
            ...(submoduleId && { navigationTargetId: submoduleId }),
            ...((submoduleId !== undefined || resource !== undefined) && {
                action: registerAction({
                    command: {
                        id: commandId,
                        arguments: [submoduleId ?? resource],
                    },
                    icon: themeIcon(submoduleId ? 'file-submodule' : 'diff'),
                    label: boundedActionLabel(
                        submoduleId
                            ? `Toggle the ${basename(file.path)} submodule repository`
                            : `Open changes in ${file.path}`,
                    ),
                }),
            }),
            ...(mode === 'working' &&
                !submoduleId && {
                    actions: [
                        registerAction({
                            command: {
                                id: 'caxri.git.discard',
                                arguments: [repo.id, file.path],
                            },
                            icon: themeIcon('discard'),
                            emphasis: 'danger',
                            errorMessage: 'Discard failed',
                            label: file.kind === 'untracked' ? 'Delete File' : 'Discard Changes',
                            accessibilityLabel:
                                file.kind === 'untracked'
                                    ? `Delete ${basename(file.path)}`
                                    : `Discard changes in ${basename(file.path)}`,
                        }),
                    ],
                }),
        };
    });
}

function emptyMessageForMode(
    mode: GitSourceControlMode,
    repo: GitRepositorySummary,
    details: GitCommitDetails | undefined,
    hasDetailError: boolean,
    pullRequest: GitPullRequestChanges | null | undefined,
    selectedCommitSha?: string,
): string {
    if (mode === 'working') return 'Working tree clean.';
    if (mode === 'commit') {
        if (!repo.head) return 'No commits yet.';
        if (hasDetailError)
            return selectedCommitSha
                ? `Unable to load commit ${selectedCommitSha.slice(0, 7)}.`
                : 'Unable to load the last commit.';
        if (selectedCommitSha)
            return details
                ? `Commit ${selectedCommitSha.slice(0, 7)} has no file changes.`
                : `Loading commit ${selectedCommitSha.slice(0, 7)}…`;
        return details ? 'Last commit has no file changes.' : 'Loading last commit…';
    }
    if (hasDetailError) return 'Unable to load pull request changes.';
    return pullRequest === null
        ? 'No pull request for this branch.'
        : pullRequest
          ? 'Pull request has no file changes.'
          : 'Loading pull request changes…';
}

function summaryErrorMessage(error: string | undefined): string {
    const known: Readonly<Record<string, string>> = {
        [ProjectStatusSummaryErrorMessage.missingGitRepository]:
            'This folder is not a Git repository.',
        'Git is not installed or is unavailable on PATH.':
            'Git is not installed or is unavailable on PATH.',
        'The Git operation timed out.': 'The Git operation timed out.',
        'Git output exceeded the safety limit.': 'Git output exceeded the safety limit.',
    };
    return known[error ?? ''] ?? 'This folder is not a Git repository.';
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
}: BuildSourceControlViewModelOptions): SourceControlViewModel {
    const emptyMessage = !summary.isRepository
        ? summaryErrorMessage(summary.error)
        : summary.repositories.length === 0
          ? 'No approved Git repositories found.'
          : undefined;
    const fileHistory = summary.isRepository
        ? fileHistoryModel(activeResource, fileHistoryRepositories, revision)
        : undefined;
    return {
        revision,
        title: 'Source Control',
        accessibilityLabel: 'Git repositories',
        modeAccessibilityLabel: 'Source control mode',
        modes: [...sourceControlModes(selectedCommitSha)],
        selectedModeId: mode,
        refreshAction: registerAction({
            command: { id: 'caxri.git.refresh' },
            icon: themeIcon('refresh'),
            label: mode === 'pull-request' ? 'Refresh Pull Request' : 'Refresh Git',
        }),
        ...(fileHistory && { fileHistory }),
        providers: summary.repositories.map((repo) => {
            const details = detailsByRepo.get(repo.id);
            const pullRequest = pullRequestsByRepo.get(repo.id);
            const files =
                mode === 'working'
                    ? repo.files
                    : mode === 'commit'
                      ? commitFilesToStatuses(details)
                      : (pullRequest?.files ?? []);
            const count = mode === 'working' ? repo.changedFileCount : files.length;
            const description = pullRequest
                ? `#${pullRequest.number} ${pullRequest.title}`
                : details
                  ? `${details.commit.shortSha} ${details.commit.subject}`
                  : repo.branch;
            const descriptionAccessibilityLabel = pullRequest
                ? `Pull request #${pullRequest.number}: ${pullRequest.title}`
                : `${repo.ahead} ahead, ${repo.behind} behind`;
            const descriptionTooltip = pullRequest
                ? `Pull request #${pullRequest.number}: ${pullRequest.baseRefName} ← ${pullRequest.headRefName}`
                : `${repo.ahead} ahead, ${repo.behind} behind`;
            const groupLabel = pullRequest
                ? `PR #${pullRequest.number} Changes`
                : mode === 'commit'
                  ? details
                      ? `Commit ${details.commit.shortSha}`
                      : 'Last Commit'
                  : 'Changes';
            const actions: SourceControlAction[] = [];
            const aggregateResource = aggregateEditorResource(mode, repo.id, repo.name);
            if (mode === 'working')
                actions.push(
                    registerAction({
                        command: {
                            id: 'caxri.git.discardAll',
                            arguments: [repo.id],
                        },
                        disabled: repo.changedFileCount === 0,
                        icon: themeIcon('discard'),
                        emphasis: 'danger',
                        errorMessage: 'Discard failed',
                        label: 'Discard All Changes',
                    }),
                );
            if (mode !== 'commit')
                actions.push(
                    registerAction({
                        command: {
                            id: 'caxri.git.openChanges',
                            arguments: [aggregateResource],
                        },
                        disabled: files.length === 0,
                        icon: themeIcon('diff-multiple'),
                        label:
                            mode === 'pull-request'
                                ? 'Open Pull Request Changes'
                                : 'Open Working Tree Changes',
                        accessibilityLabel:
                            mode === 'pull-request' ? 'Open Pull Request Changes' : 'Open Changes',
                    }),
                );
            return {
                id: repo.id,
                label: repo.name,
                ...(repo.kind !== 'primary' && { kindLabel: repo.kind }),
                icon: themeIcon(repo.kind === 'primary' ? 'folder-git' : 'file-submodule'),
                tooltip: repo.rootPath,
                description,
                descriptionAccessibilityLabel,
                descriptionTooltip,
                countLabel: `${mode === 'working' ? ` · ↑${repo.ahead} ↓${repo.behind}` : ''} · ${count}`,
                expandedByDefault: true,
                actions:
                    mode === 'working'
                        ? [
                              registerAction({
                                  command: {
                                      id: 'caxri.git.sync',
                                      arguments: [repo.id, repo.ahead, repo.behind],
                                  },
                                  icon: themeIcon('sync'),
                                  label: `Sync Changes in ${repo.name}`,
                                  progressLabel: `Syncing ${repo.name}`,
                                  errorMessage: 'Sync failed',
                                  tooltip: 'Sync Changes (Pull, then Push)',
                              }),
                          ]
                        : [],
                groups: [
                    {
                        id: `${repo.id}:changes`,
                        label: groupLabel,
                        count,
                        expandedByDefault: true,
                        emptyMessage: emptyMessageForMode(
                            mode,
                            repo,
                            details,
                            detailErrorsByRepo.has(repo.id),
                            pullRequest,
                            selectedCommitSha,
                        ),
                        ...(mode === 'working' &&
                            repo.truncated && {
                                truncationMessage: `Showing the first ${repo.files.length} of ${repo.changedFileCount} changes`,
                            }),
                        ...(mode === 'commit' &&
                            details?.filesTruncated && {
                                truncationMessage: `Showing the first ${details.files.length} files of this commit`,
                            }),
                        actions,
                        resources: resourcesForRepo(
                            mode,
                            repo,
                            summary.repositories,
                            files,
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
        ...(emptyMessage && { emptyMessage }),
    };
}
