import {
    ChevronDown,
    ChevronRight,
    Files,
    Folder,
    FolderOpen,
    GitBranch,
    RefreshCw,
} from 'lucide-react';
import { useState } from 'react';

import { parseGitDiffTab, type GitDiffTab } from '@shared/git-diff';
import type { GitRepositorySummary } from '@shared/types';

import { Button } from '../../../../components/ui/button';
import { cn } from '../../../../lib/utils';
import { useCaxriQuery, useToastOnQueryError } from '../../../../queries/client';
import { useSelectedSession } from '../../../../stores/selectors';
import { useActiveWork } from '../../../../stores/session-view';
import { openGitChangesDiff, openGitFileDiff } from './git-diff-actions';
import { buildGitFileTree, type GitFileTreeNode } from './git-tree';

const gitRowClassName =
    'git-row flex w-full items-center gap-2 h-7 px-2 border-0 bg-surface text-left cursor-pointer';

function GitTreeItems({
    depth = 0,
    nodes,
    onSelect,
    selected,
}: {
    depth?: number;
    nodes: GitFileTreeNode[];
    onSelect: (path: string) => void;
    selected?: string;
}) {
    return nodes.map((node) => {
        if (node.kind === 'directory') {
            return (
                <GitTreeDirectory
                    key={node.path}
                    depth={depth}
                    node={node}
                    onSelect={onSelect}
                    selected={selected}
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
                <span
                    className={cn(
                        `status status-${file.kind}`,
                        'min-w-4 font-mono font-bold text-warning',
                        (file.kind === 'added' || file.kind === 'untracked') && 'text-success',
                        (file.kind === 'deleted' || file.kind === 'conflicted') && 'text-danger',
                    )}
                >
                    {file.index === ' ' ? file.workingTree : file.index}
                </span>
                <span className="truncate">{node.name}</span>
            </button>
        );
    });
}

function GitTreeDirectory({
    depth,
    node,
    onSelect,
    selected,
}: {
    depth: number;
    node: Extract<GitFileTreeNode, { kind: 'directory' }>;
    onSelect: (path: string) => void;
    selected?: string;
}) {
    const [expanded, setExpanded] = useState(true);
    return (
        <div>
            <button
                className="git-tree-directory flex w-full h-7 items-center gap-1.5 pr-2 border-0 bg-surface text-foreground text-left cursor-pointer hover:bg-elevated"
                style={{ paddingLeft: 8 + depth * 14 }}
                aria-expanded={expanded}
                title={node.path}
                onClick={() => setExpanded((value) => !value)}
            >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                <span className="truncate">{node.name}</span>
            </button>
            {expanded && (
                <GitTreeItems
                    depth={depth + 1}
                    nodes={node.children}
                    onSelect={onSelect}
                    selected={selected}
                />
            )}
        </div>
    );
}

function GitRepositorySection({
    activeDiff,
    repository,
}: {
    activeDiff?: GitDiffTab;
    repository: GitRepositorySummary;
}) {
    const [expanded, setExpanded] = useState(true);
    const selectedPath =
        activeDiff?.kind === 'file' && activeDiff.repositoryId === repository.id
            ? activeDiff.path
            : undefined;
    return (
        <section className="git-repository-section border-b border-border">
            <button
                className="git-repository-row flex w-full items-center justify-between gap-2 p-2 border-0 bg-surface text-foreground text-left cursor-pointer hover:bg-elevated"
                aria-expanded={expanded}
                title={repository.rootPath}
                onClick={() => setExpanded((value) => !value)}
            >
                <span className="flex min-w-0 items-center gap-1">
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <GitBranch size={12} />
                    <strong className="truncate font-semibold">{repository.name}</strong>
                    <small className="truncate text-muted text-[11px]">{repository.kind}</small>
                </span>
                <span
                    className="truncate text-muted text-[11px]"
                    title={`${repository.ahead} ahead, ${repository.behind} behind`}
                >
                    {repository.branch} · ↑{repository.ahead} ↓{repository.behind} ·{' '}
                    {repository.files.length}
                </span>
            </button>
            {expanded && (
                <div className="git-files overflow-visible">
                    <div className="git-changes-caption flex items-center justify-between py-1.5 px-2 text-muted text-[10px] font-bold tracking-[0.06em] uppercase">
                        <span>Changes</span>
                        <span className="git-changes-actions flex items-center gap-1">
                            <Button
                                className="git-open-changes size-6"
                                size="icon"
                                variant="ghost"
                                aria-label="Open Changes"
                                title="Open Changes"
                                disabled={repository.files.length === 0}
                                onClick={() => openGitChangesDiff(repository.id, repository.name)}
                            >
                                <Files size={13} />
                            </Button>
                            <span>{repository.files.length}</span>
                        </span>
                    </div>
                    {repository.files.length === 0 && (
                        <div className="empty-panel py-4 px-3 text-muted text-center">
                            Working tree clean.
                        </div>
                    )}
                    {repository.files.length > 0 && (
                        <GitTreeItems
                            nodes={buildGitFileTree(repository.files)}
                            selected={selectedPath}
                            onSelect={(path) => openGitFileDiff(repository.id, path)}
                        />
                    )}
                </div>
            )}
        </section>
    );
}

/**
 * Mounted with `key={session.id}` by the Inspector shell, so repository and diff selection reset
 * whenever the selected Session changes instead of leaking across Project roots.
 */
export function GitPanel() {
    const session = useSelectedSession();
    const activeWork = useActiveWork();
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
    const refresh = (): void => void refetch();
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
    return (
        <div className="inspector-content git-panel flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="git-heading flex items-center justify-between p-2 border-b border-border">
                <span className="flex items-center gap-2">
                    <GitBranch size={13} /> Source Control
                </span>
                <Button size="icon" variant="ghost" aria-label="Refresh Git" onClick={refresh}>
                    <RefreshCw size={13} />
                </Button>
            </div>
            <div
                className="git-repositories min-h-0 flex-1 overflow-auto border-b border-border"
                aria-label="Git repositories"
            >
                {summary.repositories.map((repository) => (
                    <GitRepositorySection
                        key={repository.id}
                        repository={repository}
                        activeDiff={activeDiff}
                    />
                ))}
            </div>
        </div>
    );
}
