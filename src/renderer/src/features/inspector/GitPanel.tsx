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

import { Button } from '../../components/ui/button';
import { useCaxriQuery, useToastOnQueryError } from '../../state/queries';
import { useSelectedSession } from '../../state/selectors';
import { useActiveWork } from '../../state/session-view';
import { openGitChangesDiff, openGitFileDiff } from './git-diff-actions';
import { buildGitFileTree, type GitFileTreeNode } from './git-tree';

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
                className={selected === file.path ? 'git-row active' : 'git-row'}
                style={{ paddingLeft: 10 + depth * 14 }}
                title={file.path}
                onClick={() => onSelect(file.path)}
            >
                <span className={`status status-${file.kind}`}>
                    {file.index === ' ' ? file.workingTree : file.index}
                </span>
                <span>{node.name}</span>
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
                className="git-tree-directory"
                style={{ paddingLeft: 8 + depth * 14 }}
                aria-expanded={expanded}
                title={node.path}
                onClick={() => setExpanded((value) => !value)}
            >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                <span>{node.name}</span>
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
        <section className="git-repository-section">
            <button
                className="git-repository-row"
                aria-expanded={expanded}
                title={repository.rootPath}
                onClick={() => setExpanded((value) => !value)}
            >
                <span>
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <GitBranch size={12} />
                    <strong>{repository.name}</strong>
                    <small>{repository.kind}</small>
                </span>
                <span title={`${repository.ahead} ahead, ${repository.behind} behind`}>
                    {repository.branch} · ↑{repository.ahead} ↓{repository.behind} ·{' '}
                    {repository.files.length}
                </span>
            </button>
            {expanded && (
                <div className="git-files">
                    <div className="git-changes-caption">
                        <span>Changes</span>
                        <span className="git-changes-actions">
                            <Button
                                className="git-open-changes"
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
                        <div className="empty-panel">Working tree clean.</div>
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
    if (!session) return <div className="empty-panel">Create a Session to inspect Git.</div>;
    if (!summary) return <div className="empty-panel">Loading Git status…</div>;
    if (!summary.isRepository) return <div className="empty-panel">{summary.error}</div>;
    if (summary.repositories.length === 0)
        return <div className="empty-panel">No approved Git repositories found.</div>;
    return (
        <div className="inspector-content git-panel">
            <div className="git-heading">
                <span>
                    <GitBranch size={13} /> Source Control
                </span>
                <Button size="icon" variant="ghost" aria-label="Refresh Git" onClick={refresh}>
                    <RefreshCw size={13} />
                </Button>
            </div>
            <div className="git-repositories" aria-label="Git repositories">
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
