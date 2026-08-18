import { useEffect, useRef, useState } from 'react';

import type { GitDiffTab } from '@shared/git-diff';
import { parseGitDiffTab } from '@shared/git-diff';
import type { GitRepositorySummary } from '@shared/types';
import { ChevronDown, ChevronRight, GitBranch, GitPullRequest, RefreshCw } from 'lucide-react';

import { DisclosureMotion } from '../../../../components/disclosure-motion';
import { Button } from '../../../../components/ui/button';
import { Empty } from '../../../../components/ui/empty';
import { Tooltip } from '../../../../components/ui/tooltip';
import { DiffMultipleIcon } from '../../../../icons/codicons/diff-multiple-icon';
import { FileSubmoduleIcon } from '../../../../icons/codicons/file-submodule-icon';
import { FileTypeIcon } from '../../../../icons/files/file-type-icon';
import { cn } from '../../../../lib/utilities';
import { useCaxriQuery, useToastOnQueryError } from '../../../../queries/client';
import { useSelectedSession } from '../../../../stores/selectors';
import { useActiveWork } from '../../../../stores/session-view';
import { CommitHistory } from './commit-history';
import {
    openGitChangesDiff,
    openGitFileDiff,
    openPullRequestChangesDiff,
    openPullRequestFileDiff,
} from './git-diff-actions';
import { GitFileStatusLetter } from './git-file-status-letter';
import type { GitFileTreeNode } from './git-tree';
import { buildGitFileTree, submoduleRepositoriesByPath } from './git-tree';

const gitRowClassName =
    'git-row flex w-full items-center gap-2 h-7 px-2 border-0 bg-surface text-left cursor-pointer';

type GitPanelMode = 'pull-request' | 'working';

function GitTreeItems({
    depth = 0,
    expandedDirectories,
    nodes,
    onFocusRepository,
    onSelect,
    repositoryKey,
    selected,
    setDirectoryExpanded,
    submodulesByPath,
}: {
    depth?: number;
    expandedDirectories: Readonly<Record<string, boolean | undefined>>;
    nodes: GitFileTreeNode[];
    onFocusRepository: (repoId: string) => void;
    onSelect: (path: string) => void;
    repositoryKey: string;
    selected?: string;
    setDirectoryExpanded: (key: string, isExpanded: boolean) => void;
    submodulesByPath: ReadonlyMap<string, GitRepositorySummary>;
}) {
    return nodes.map((node) => {
        if (node.kind === 'directory') {
            return (
                <GitTreeDirectory
                    key={node.path}
                    depth={depth}
                    expandedDirectories={expandedDirectories}
                    node={node}
                    onFocusRepository={onFocusRepository}
                    onSelect={onSelect}
                    repositoryKey={repositoryKey}
                    selected={selected}
                    setDirectoryExpanded={setDirectoryExpanded}
                    submodulesByPath={submodulesByPath}
                />
            );
        }
        const file = node.file;
        const submodule = submodulesByPath.get(file.path);
        if (submodule) {
            // A submodule bump has no meaningful file diff; the row jumps to the submodule's own
            // repository section below instead of opening one.
            return (
                <button
                    key={file.path}
                    className={cn(gitRowClassName, 'git-submodule-row hover:bg-elevated')}
                    style={{ paddingLeft: 10 + depth * 14 }}
                    title={`Show the ${submodule.name} submodule repository`}
                    onClick={() => onFocusRepository(submodule.id)}
                >
                    <FileSubmoduleIcon size={14} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                    <small className="shrink-0 text-[11px] whitespace-nowrap text-muted">
                        submodule
                    </small>
                    <GitFileStatusLetter file={file} />
                </button>
            );
        }
        return (
            <button
                key={file.path}
                className={cn(
                    gitRowClassName,
                    'hover:bg-elevated',
                    selected === file.path && 'active bg-elevated',
                )}
                style={{ paddingLeft: 10 + depth * 14 }}
                title={file.path}
                onClick={() => onSelect(file.path)}
            >
                <FileTypeIcon entry={{ kind: 'file', name: node.name }} />
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                <GitFileStatusLetter file={file} />
            </button>
        );
    });
}

function GitTreeDirectory({
    depth,
    expandedDirectories,
    node,
    onFocusRepository,
    onSelect,
    repositoryKey,
    selected,
    setDirectoryExpanded,
    submodulesByPath,
}: {
    depth: number;
    expandedDirectories: Readonly<Record<string, boolean | undefined>>;
    node: Extract<GitFileTreeNode, { kind: 'directory' }>;
    onFocusRepository: (repoId: string) => void;
    onSelect: (path: string) => void;
    repositoryKey: string;
    selected?: string;
    setDirectoryExpanded: (key: string, isExpanded: boolean) => void;
    submodulesByPath: ReadonlyMap<string, GitRepositorySummary>;
}) {
    const expansionKey = `${repositoryKey}:${node.path}`;
    const isExpanded = expandedDirectories[expansionKey] ?? true;
    return (
        <div>
            <button
                className="git-tree-directory flex h-7 w-full cursor-pointer items-center gap-1.5 border-0 bg-surface pr-2 text-left text-foreground hover:bg-elevated"
                style={{ paddingLeft: 8 + depth * 14 }}
                aria-expanded={isExpanded}
                title={node.path}
                onClick={() => setDirectoryExpanded(expansionKey, !isExpanded)}
            >
                {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <FileTypeIcon
                    entry={{ kind: 'directory', name: node.name }}
                    expanded={isExpanded}
                />
                <span className="truncate">{node.name}</span>
            </button>
            <DisclosureMotion animate expanded={isExpanded} kind="git-directory">
                {() => (
                    <GitTreeItems
                        depth={depth + 1}
                        expandedDirectories={expandedDirectories}
                        nodes={node.children}
                        onFocusRepository={onFocusRepository}
                        onSelect={onSelect}
                        repositoryKey={repositoryKey}
                        selected={selected}
                        setDirectoryExpanded={setDirectoryExpanded}
                        submodulesByPath={submodulesByPath}
                    />
                )}
            </DisclosureMotion>
        </div>
    );
}

function GitRepoSection({
    activeDiff,
    expanded,
    expandedDirectories,
    flashed,
    mode,
    onExpandedChange,
    onFocusRepository,
    pullRequestRefresh,
    repository,
    sessionId,
    setDirectoryExpanded,
    submodulesByPath,
}: {
    activeDiff?: GitDiffTab;
    expanded: boolean;
    expandedDirectories: Readonly<Record<string, boolean | undefined>>;
    flashed: boolean;
    mode: GitPanelMode;
    onExpandedChange: (isExpanded: boolean) => void;
    onFocusRepository: (repoId: string) => void;
    pullRequestRefresh: number;
    repository: GitRepositorySummary;
    sessionId: string;
    setDirectoryExpanded: (key: string, isExpanded: boolean) => void;
    submodulesByPath: ReadonlyMap<string, GitRepositorySummary>;
}) {
    // Local like the Commits disclosure in `commit-history.tsx`; not persisted across session switches.
    const [changesExpanded, setChangesExpanded] = useState(true);
    const pullRequestQuery = useCaxriQuery(
        'git.pullRequestChanges',
        {
            sessionId,
            repositoryId: repository.id,
            refresh: pullRequestRefresh,
        },
        { enabled: mode === 'pull-request' },
    );
    useToastOnQueryError(
        pullRequestQuery.isError,
        pullRequestQuery.error,
        'Pull request refresh failed',
    );
    const pullRequest = mode === 'pull-request' ? pullRequestQuery.data : undefined;
    const files = mode === 'working' ? repository.files : (pullRequest?.files ?? []);
    /**
     * The working-tree count comes from `changedFileCount`, not `files.length`: the Runtime caps the transported
     * `files[]` payload at `MAX_GIT_STATUS_FILES`, so a very large change set can be truncated while `changedFileCount`
     * still reports its true, untruncated size — the same source the Status Bar reads through `git.overview`.
     */
    const displayedCount = mode === 'working' ? repository.changedFileCount : files.length;
    const selectedPath =
        activeDiff?.kind === 'file' &&
        activeDiff.repositoryId === repository.id &&
        activeDiff.source === mode
            ? activeDiff.path
            : undefined;
    const openFile = mode === 'pull-request' ? openPullRequestFileDiff : openGitFileDiff;
    const openChanges = mode === 'pull-request' ? openPullRequestChangesDiff : openGitChangesDiff;
    const emptyMessage =
        mode === 'working'
            ? 'Working tree clean.'
            : pullRequestQuery.isError
              ? 'Unable to load pull request changes.'
              : pullRequest === undefined
                ? 'Loading pull request changes…'
                : pullRequest === null
                  ? 'No pull request for this branch.'
                  : 'Pull request has no file changes.';
    return (
        <section
            className={cn(
                'git-repository-section border-b border-border transition-[outline-color] duration-500',
                // The jump-target flash outlines the whole section: a header-only background tint
                // is too subtle to notice when the section is already expanded and nothing scrolls.
                flashed && 'outline-1 -outline-offset-1 outline-accent',
            )}
            data-git-repository-id={repository.id}
        >
            <button
                className={cn(
                    'git-repository-row flex w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden border-0 bg-surface p-2 text-left text-foreground transition-colors duration-500 hover:bg-elevated',
                    flashed && 'bg-elevated',
                )}
                aria-expanded={expanded}
                title={repository.rootPath}
                onClick={() => onExpandedChange(!expanded)}
            >
                <span className="git-repository-identity flex shrink-0 items-center gap-1">
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    {mode === 'pull-request' ? (
                        <GitPullRequest size={12} />
                    ) : (
                        <GitBranch size={12} />
                    )}
                    <strong className="git-repository-name shrink-0 font-semibold whitespace-nowrap">
                        {repository.name}
                    </strong>
                    {repository.kind !== 'primary' && (
                        <small className="git-repository-kind shrink-0 text-[11px] whitespace-nowrap text-muted">
                            {repository.kind}
                        </small>
                    )}
                </span>
                <span
                    className="git-repository-meta flex min-w-0 flex-1 items-center justify-end gap-1 text-[11px] text-muted"
                    title={
                        pullRequest
                            ? `Pull request #${pullRequest.number}: ${pullRequest.baseRefName} ← ${pullRequest.headRefName}`
                            : `${repository.ahead} ahead, ${repository.behind} behind`
                    }
                >
                    <span className="git-repository-branch min-w-0 truncate">
                        {pullRequest
                            ? `#${pullRequest.number} ${pullRequest.title}`
                            : repository.branch}
                    </span>
                    <span className="git-repository-counts shrink-0 whitespace-nowrap">
                        {mode === 'working' && ` · ↑${repository.ahead} ↓${repository.behind}`}
                        {' · '}
                        {displayedCount}
                    </span>
                </span>
            </button>
            <DisclosureMotion animate expanded={expanded} kind="git-repository">
                {() => (
                    <div className="git-files overflow-visible">
                        <div className="git-changes-caption flex items-center justify-between pr-2 text-[10px] font-bold tracking-[0.06em] text-muted uppercase">
                            <button
                                type="button"
                                className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1 border-0 bg-transparent px-2 text-left text-[10px] font-bold tracking-[0.06em] text-muted uppercase hover:text-foreground"
                                aria-expanded={changesExpanded}
                                onClick={() => setChangesExpanded((value) => !value)}
                            >
                                {changesExpanded ? (
                                    <ChevronDown size={12} />
                                ) : (
                                    <ChevronRight size={12} />
                                )}
                                <span className="truncate">
                                    {pullRequest ? `PR #${pullRequest.number} Changes` : 'Changes'}
                                </span>
                            </button>
                            <span className="git-changes-actions flex items-center gap-1">
                                <Tooltip
                                    content={
                                        mode === 'pull-request'
                                            ? 'Open Pull Request Changes'
                                            : 'Open Working Tree Changes'
                                    }
                                >
                                    <Button
                                        className="git-open-changes size-6"
                                        size="icon"
                                        variant="ghost"
                                        aria-label={
                                            mode === 'pull-request'
                                                ? 'Open Pull Request Changes'
                                                : 'Open Changes'
                                        }
                                        disabled={files.length === 0}
                                        onClick={() => openChanges(repository.id, repository.name)}
                                    >
                                        <DiffMultipleIcon size={13} />
                                    </Button>
                                </Tooltip>
                                <span>{displayedCount}</span>
                            </span>
                        </div>
                        <DisclosureMotion animate expanded={changesExpanded} kind="git-changes">
                            {() => (
                                <div className="git-changes-body">
                                    {mode === 'working' && repository.truncated && (
                                        <div
                                            role="status"
                                            aria-live="polite"
                                            className="git-changes-truncated border-b border-border bg-surface px-3 py-1.5 text-[11px] text-muted"
                                        >
                                            Showing the first {repository.files.length} of{' '}
                                            {repository.changedFileCount} changes
                                        </div>
                                    )}
                                    {files.length === 0 && (
                                        <Empty className="empty-panel gap-0 p-0 px-3 py-4 text-muted">
                                            {emptyMessage}
                                        </Empty>
                                    )}
                                    {files.length > 0 && (
                                        <GitTreeItems
                                            expandedDirectories={expandedDirectories}
                                            nodes={buildGitFileTree(files)}
                                            repositoryKey={`${mode}:${repository.id}`}
                                            selected={selectedPath}
                                            setDirectoryExpanded={setDirectoryExpanded}
                                            submodulesByPath={submodulesByPath}
                                            onFocusRepository={onFocusRepository}
                                            onSelect={(path) => openFile(repository.id, path)}
                                        />
                                    )}
                                </div>
                            )}
                        </DisclosureMotion>
                        {mode === 'working' && (
                            <CommitHistory repository={repository} sessionId={sessionId} />
                        )}
                    </div>
                )}
            </DisclosureMotion>
        </section>
    );
}

/**
 * Mounted with `key={session.id}` by the Inspector shell. Workbench-root navigation is retained in this component so
 * switching roots clears stale selection while a later return restores it.
 */
export function GitPanel() {
    const session = useSelectedSession();
    const activeWork = useActiveWork();
    const scope = session ? `${session.id}:${session.workbenchProjectId}` : undefined;
    const [navigationByScope, setNavigationByScope] = useState<
        Record<
            string,
            {
                expandedDirectories: Record<string, boolean | undefined>;
                expandedRepositories: Record<string, boolean | undefined>;
                mode: GitPanelMode;
            }
        >
    >({});
    const [pullRequestRefresh, setPullRequestRefresh] = useState(0);
    const [workingRefresh, setWorkingRefresh] = useState(0);
    const [flashedRepoId, setFlashedRepoId] = useState<string>();
    const repositoriesReference = useRef<HTMLDivElement>(null);
    const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(flashTimer.current), []);
    const navigation = scope
        ? (navigationByScope[scope] ?? {
              expandedDirectories: {},
              expandedRepositories: {},
              mode: 'working' as const,
          })
        : { expandedDirectories: {}, expandedRepositories: {}, mode: 'working' as const };
    const mode = navigation.mode;
    const updateNavigation = (patch: Partial<(typeof navigationByScope)[string]>): void => {
        if (!scope) return;
        setNavigationByScope((current) => ({
            ...current,
            [scope]: { ...navigation, ...patch },
        }));
    };
    const setMode = (nextMode: GitPanelMode): void => updateNavigation({ mode: nextMode });
    const setDirectoryExpanded = (key: string, isExpanded: boolean): void =>
        updateNavigation({
            expandedDirectories: { ...navigation.expandedDirectories, [key]: isExpanded },
        });
    const sessionId = session?.id;
    const activeDiff = activeWork?.kind === 'editor' ? parseGitDiffTab(activeWork.path) : undefined;
    /**
     * `git.changed` invalidation is wired centrally in `useRuntimeQueryInvalidation`, so this query only needs to
     * describe what it reads; the re-fetch on Git-affecting repository activity happens without a local effect. The
     * manual Refresh button instead bumps `workingRefresh`, a monotonic nonce baked into the query key: changing it
     * forces the Runtime to serve the newest snapshot generation instead of joining an in-flight cached one.
     */
    const {
        data: summary,
        isError,
        error,
    } = useCaxriQuery(
        'git.summary',
        { sessionId: sessionId ?? '', refresh: workingRefresh },
        { enabled: Boolean(sessionId) },
    );
    useToastOnQueryError(isError, error, 'Git refresh failed');
    if (!session)
        return (
            <Empty className="empty-panel gap-0 p-0 px-3 py-4 text-muted">
                Create a Session to inspect Git.
            </Empty>
        );
    if (!summary)
        return (
            <Empty className="empty-panel gap-0 p-0 px-3 py-4 text-muted">
                Loading Git status…
            </Empty>
        );
    if (!summary.isRepository)
        return (
            <Empty className="empty-panel gap-0 p-0 px-3 py-4 text-muted">{summary.error}</Empty>
        );
    if (summary.repositories.length === 0)
        return (
            <Empty className="empty-panel gap-0 p-0 px-3 py-4 text-muted">
                No approved Git repositories found.
            </Empty>
        );
    /**
     * Jump target for submodule rows: make sure the submodule's own section is expanded, scroll its header into view,
     * and flash it briefly so the eye lands on the right section.
     */
    const focusRepo = (repoId: string): void => {
        updateNavigation({
            expandedRepositories: {
                ...navigation.expandedRepositories,
                [repoId]: true,
            },
        });
        setFlashedRepoId(repoId);
        clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlashedRepoId(undefined), 1600);
        requestAnimationFrame(() => {
            repositoriesReference.current
                ?.querySelector(`[data-git-repository-id="${CSS.escape(repoId)}"]`)
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    };
    const refresh = (): void => {
        if (mode === 'working') {
            setWorkingRefresh((value) => value + 1);
        } else {
            setPullRequestRefresh((value) => value + 1);
        }
    };
    return (
        <div className="inspector-content git-panel flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="git-heading flex items-center gap-2 border-b border-border p-2">
                <span className="flex items-center gap-2">
                    <GitBranch size={13} /> Source Control
                </span>
                <div
                    className="git-mode-switch ml-auto flex h-7 items-center rounded-md bg-elevated p-0.5"
                    role="group"
                    aria-label="Source control mode"
                >
                    <Tooltip content="Working Tree Changes">
                        <button
                            type="button"
                            className={cn(
                                'grid size-6 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted hover:text-foreground',
                                mode === 'working' && 'bg-surface text-foreground',
                            )}
                            aria-label="Working Tree Changes"
                            aria-pressed={mode === 'working'}
                            onClick={() => setMode('working')}
                        >
                            <GitBranch size={13} />
                        </button>
                    </Tooltip>
                    <Tooltip content="Pull Request Changes">
                        <button
                            type="button"
                            className={cn(
                                'grid size-6 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted hover:text-foreground',
                                mode === 'pull-request' && 'bg-surface text-foreground',
                            )}
                            aria-label="Pull Request Changes"
                            aria-pressed={mode === 'pull-request'}
                            onClick={() => setMode('pull-request')}
                        >
                            <GitPullRequest size={13} />
                        </button>
                    </Tooltip>
                </div>
                <Tooltip content={mode === 'working' ? 'Refresh Git' : 'Refresh Pull Request'}>
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label={mode === 'working' ? 'Refresh Git' : 'Refresh Pull Request'}
                        onClick={refresh}
                    >
                        <RefreshCw size={13} />
                    </Button>
                </Tooltip>
            </div>
            <div
                ref={repositoriesReference}
                className="git-repositories min-h-0 flex-1 overflow-auto border-b border-border"
                aria-label="Git repositories"
            >
                {summary.repositories.map((repo) => (
                    <GitRepoSection
                        key={repo.id}
                        repository={repo}
                        activeDiff={activeDiff}
                        expanded={navigation.expandedRepositories[repo.id] ?? true}
                        expandedDirectories={navigation.expandedDirectories}
                        flashed={flashedRepoId === repo.id}
                        mode={mode}
                        submodulesByPath={submoduleRepositoriesByPath(repo, summary.repositories)}
                        onFocusRepository={focusRepo}
                        onExpandedChange={(isExpanded) =>
                            updateNavigation({
                                expandedRepositories: {
                                    ...navigation.expandedRepositories,
                                    [repo.id]: isExpanded,
                                },
                            })
                        }
                        pullRequestRefresh={pullRequestRefresh}
                        sessionId={session.id}
                        setDirectoryExpanded={setDirectoryExpanded}
                    />
                ))}
            </div>
        </div>
    );
}
