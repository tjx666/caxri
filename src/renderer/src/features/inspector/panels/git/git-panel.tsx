import { useState } from 'react';

import type { GitDiffTab } from '@shared/git-diff';
import { parseGitDiffTab } from '@shared/git-diff';
import type { GitRepositorySummary } from '@shared/types';
import {
    ChevronDown,
    ChevronRight,
    Files,
    GitBranch,
    GitPullRequest,
    RefreshCw,
} from 'lucide-react';

import { DisclosureMotion } from '../../../../components/disclosure-motion';
import { Button } from '../../../../components/ui/button';
import { Tooltip } from '../../../../components/ui/tooltip';
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
import type { GitFileTreeNode } from './git-tree';
import { buildGitFileTree } from './git-tree';

const gitRowClassName =
    'git-row flex w-full items-center gap-2 h-7 px-2 border-0 bg-surface text-left cursor-pointer';

type GitPanelMode = 'pull-request' | 'working';

function GitTreeItems({
    depth = 0,
    expandedDirectories,
    nodes,
    onSelect,
    repositoryKey,
    selected,
    setDirectoryExpanded,
}: {
    depth?: number;
    expandedDirectories: Readonly<Record<string, boolean | undefined>>;
    nodes: GitFileTreeNode[];
    onSelect: (path: string) => void;
    repositoryKey: string;
    selected?: string;
    setDirectoryExpanded: (key: string, isExpanded: boolean) => void;
}) {
    return nodes.map((node) => {
        if (node.kind === 'directory') {
            return (
                <GitTreeDirectory
                    key={node.path}
                    depth={depth}
                    expandedDirectories={expandedDirectories}
                    node={node}
                    onSelect={onSelect}
                    repositoryKey={repositoryKey}
                    selected={selected}
                    setDirectoryExpanded={setDirectoryExpanded}
                />
            );
        }
        const file = node.file;
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
                <span
                    className={cn(
                        `status status-${file.kind}`,
                        'min-w-4 flex-none text-center font-mono font-bold text-warning',
                        (file.kind === 'added' || file.kind === 'untracked') && 'text-success',
                        (file.kind === 'deleted' || file.kind === 'conflicted') && 'text-danger',
                    )}
                >
                    {file.index === ' ' ? file.workingTree : file.index}
                </span>
            </button>
        );
    });
}

function GitTreeDirectory({
    depth,
    expandedDirectories,
    node,
    onSelect,
    repositoryKey,
    selected,
    setDirectoryExpanded,
}: {
    depth: number;
    expandedDirectories: Readonly<Record<string, boolean | undefined>>;
    node: Extract<GitFileTreeNode, { kind: 'directory' }>;
    onSelect: (path: string) => void;
    repositoryKey: string;
    selected?: string;
    setDirectoryExpanded: (key: string, isExpanded: boolean) => void;
}) {
    const expansionKey = `${repositoryKey}:${node.path}`;
    const isExpanded = expandedDirectories[expansionKey] ?? true;
    return (
        <div>
            <button
                className="git-tree-directory flex w-full h-7 items-center gap-1.5 pr-2 border-0 bg-surface text-foreground text-left cursor-pointer hover:bg-elevated"
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
                        onSelect={onSelect}
                        repositoryKey={repositoryKey}
                        selected={selected}
                        setDirectoryExpanded={setDirectoryExpanded}
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
    mode,
    onExpandedChange,
    pullRequestRefresh,
    repository,
    sessionId,
    setDirectoryExpanded,
}: {
    activeDiff?: GitDiffTab;
    expanded: boolean;
    expandedDirectories: Readonly<Record<string, boolean | undefined>>;
    mode: GitPanelMode;
    onExpandedChange: (isExpanded: boolean) => void;
    pullRequestRefresh: number;
    repository: GitRepositorySummary;
    sessionId: string;
    setDirectoryExpanded: (key: string, isExpanded: boolean) => void;
}) {
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
        <section className="git-repository-section border-b border-border">
            <button
                className="git-repository-row flex w-full min-w-0 items-center gap-2 overflow-hidden p-2 border-0 bg-surface text-foreground text-left cursor-pointer hover:bg-elevated"
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
                    <strong className="git-repository-name shrink-0 whitespace-nowrap font-semibold">
                        {repository.name}
                    </strong>
                    {repository.kind !== 'primary' && (
                        <small className="git-repository-kind shrink-0 whitespace-nowrap text-muted text-[11px]">
                            {repository.kind}
                        </small>
                    )}
                </span>
                <span
                    className="git-repository-meta flex min-w-0 flex-1 items-center justify-end gap-1 text-muted text-[11px]"
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
                        {files.length}
                    </span>
                </span>
            </button>
            <DisclosureMotion animate expanded={expanded} kind="git-repository">
                {() => (
                    <div className="git-files overflow-visible">
                        <div className="git-changes-caption flex items-center justify-between py-1.5 px-2 text-muted text-[10px] font-bold tracking-[0.06em] uppercase">
                            <span>
                                {pullRequest ? `PR #${pullRequest.number} Changes` : 'Changes'}
                            </span>
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
                                        <Files size={13} />
                                    </Button>
                                </Tooltip>
                                <span>{files.length}</span>
                            </span>
                        </div>
                        {files.length === 0 && (
                            <div className="empty-panel py-4 px-3 text-muted text-center">
                                {emptyMessage}
                            </div>
                        )}
                        {files.length > 0 && (
                            <GitTreeItems
                                expandedDirectories={expandedDirectories}
                                nodes={buildGitFileTree(files)}
                                repositoryKey={`${mode}:${repository.id}`}
                                selected={selectedPath}
                                setDirectoryExpanded={setDirectoryExpanded}
                                onSelect={(path) => openFile(repository.id, path)}
                            />
                        )}
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
 * Mounted with `key={session.id}` by the Inspector shell. Workbench-root navigation is retained in
 * this component so switching roots clears stale selection while a later return restores it.
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
     * `files.changed` invalidation is wired centrally in `useRuntimeQueryInvalidation`, so this
     * query only needs to describe what it reads; the debounced re-fetch on Git-affecting file
     * activity happens without a local effect.
     */
    const {
        data: summary,
        isError,
        error,
        refetch,
    } = useCaxriQuery(
        'git.summary',
        { sessionId: sessionId ?? '' },
        { enabled: Boolean(sessionId) },
    );
    useToastOnQueryError(isError, error, 'Git refresh failed');
    if (!session)
        return (
            <div className="empty-panel py-4 px-3 text-muted text-center">
                Create a Session to inspect Git.
            </div>
        );
    if (!summary)
        return (
            <div className="empty-panel py-4 px-3 text-muted text-center">Loading Git status…</div>
        );
    if (!summary.isRepository)
        return <div className="empty-panel py-4 px-3 text-muted text-center">{summary.error}</div>;
    if (summary.repositories.length === 0)
        return (
            <div className="empty-panel py-4 px-3 text-muted text-center">
                No approved Git repositories found.
            </div>
        );
    const refresh = (): void => {
        // Fire-and-forget: `useCaxriQuery`/`useToastOnQueryError` already own reporting a failed
        // refetch, so this manual refresh trigger has nothing further to await.
        if (mode === 'working') {
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void refetch();
        } else {
            setPullRequestRefresh((value) => value + 1);
        }
    };
    return (
        <div className="inspector-content git-panel flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="git-heading flex items-center gap-2 p-2 border-b border-border">
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
                                'grid size-6 place-items-center rounded border-0 bg-transparent p-0 text-muted cursor-pointer hover:text-foreground',
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
                                'grid size-6 place-items-center rounded border-0 bg-transparent p-0 text-muted cursor-pointer hover:text-foreground',
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
                        mode={mode}
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
