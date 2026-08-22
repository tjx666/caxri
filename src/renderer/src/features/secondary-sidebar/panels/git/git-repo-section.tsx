import { useState } from 'react';

import type { GitDiffTab } from '@shared/git-diff';
import type { GitCommitDetails, GitPullRequestChanges, GitRepositorySummary } from '@shared/types';
import { ChevronDown, ChevronRight, FolderGit2 } from 'lucide-react';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { DisclosureMotion } from '../../../../components/disclosure-motion';
import { Button } from '../../../../components/ui/button';
import { Empty } from '../../../../components/ui/empty';
import { Tooltip } from '../../../../components/ui/tooltip';
import { DiffMultipleIcon } from '../../../../icons/codicons/diff-multiple-icon';
import { DiscardIcon } from '../../../../icons/codicons/discard-icon';
import { FileSubmoduleIcon } from '../../../../icons/codicons/file-submodule-icon';
import { SyncIcon } from '../../../../icons/codicons/sync-icon';
import { cn } from '../../../../lib/utilities';
import { useCaxriQuery, useToastOnQueryError } from '../../../../queries/client';
import { CommitHistory } from './commit-history';
import {
    openGitChangesDiff,
    openGitCommitFileDiff,
    openGitFileDiff,
    openPullRequestChangesDiff,
    openPullRequestFileDiff,
} from './git-diff-actions';
import { buildGitFileTree, commitFilesToStatuses } from './git-tree';
import { GitTreeItems } from './git-tree-items';
import { discardAllChanges, discardFileChanges, syncRepo } from './git-working-tree-actions';

export type GitPanelMode = 'commit' | 'pull-request' | 'working';

function GitRepoHeader({
    displayedCount,
    expanded,
    latestCommit,
    mode,
    onExpandedChange,
    pullRequest,
    repository,
    sessionId,
}: {
    displayedCount: number;
    expanded: boolean;
    latestCommit: GitCommitDetails | undefined;
    mode: GitPanelMode;
    onExpandedChange: (isExpanded: boolean) => void;
    pullRequest: GitPullRequestChanges | null | undefined;
    repository: GitRepositorySummary;
    sessionId: string;
}) {
    const [syncing, setSyncing] = useState(false);
    const runSync = async (): Promise<void> => {
        if (syncing) return;
        setSyncing(true);
        try {
            await syncRepo(sessionId, repository.id);
        } finally {
            setSyncing(false);
        }
    };
    return (
        /* The toggle stays a plain button (its class and title anchor the E2E selectors) and the Sync action is a
           flex sibling rather than a nested one, so no button ever nests. Sync holds its own slot instead of being
           overlaid: it is always visible, and an overlay would have to sit on top of the ahead/behind counts. Row
           hover moves up to this wrapper so the highlight still covers the whole row including the Sync slot. */
        <div className="git-repository-header group flex items-center bg-surface hover:bg-elevated">
            <button
                className="git-repository-row flex min-w-0 flex-1 cursor-pointer items-center gap-2 overflow-hidden border-0 bg-transparent p-2 text-left text-foreground"
                aria-expanded={expanded}
                title={repository.rootPath}
                onClick={() => onExpandedChange(!expanded)}
            >
                <span className="git-repository-identity flex shrink-0 items-center gap-1">
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    {/* The mark names what the row *is* — a repository — not which mode the panel is in;
                        the mode already has its own segmented control in the panel header, and repeating it
                        here is what made four near-identical branch glyphs share one screen. */}
                    {repository.kind === 'primary' ? (
                        <FolderGit2 size={12} />
                    ) : (
                        <FileSubmoduleIcon size={12} />
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
                            : latestCommit
                              ? `${latestCommit.commit.shortSha} ${latestCommit.commit.subject}`
                              : repository.branch}
                    </span>
                    <span className="git-repository-counts shrink-0 whitespace-nowrap">
                        {mode === 'working' && ` · ↑${repository.ahead} ↓${repository.behind}`}
                        {' · '}
                        {displayedCount}
                    </span>
                </span>
            </button>
            {mode === 'working' && (
                <Tooltip content="Sync Changes (Pull, then Push)">
                    <Button
                        className="git-sync mr-1 flex size-6 flex-none"
                        size="icon"
                        variant="ghost"
                        aria-label={`Sync Changes in ${repository.name}`}
                        disabled={syncing}
                        onClick={() => {
                            // eslint-disable-next-line no-void -- intentional floating-promise discard, syncRepo reports its own errors via tryCommand
                            void runSync();
                        }}
                    >
                        <SyncIcon size={13} className={syncing ? 'animate-spin' : undefined} />
                    </Button>
                </Tooltip>
            )}
        </div>
    );
}

function GitChangesCaption({
    changesExpanded,
    displayedCount,
    filesCount,
    latestCommit,
    mode,
    onToggle,
    pullRequest,
    repository,
    sessionId,
}: {
    changesExpanded: boolean;
    displayedCount: number;
    filesCount: number;
    latestCommit: GitCommitDetails | undefined;
    mode: GitPanelMode;
    onToggle: () => void;
    pullRequest: GitPullRequestChanges | null | undefined;
    repository: GitRepositorySummary;
    sessionId: string;
}) {
    const openChanges = mode === 'pull-request' ? openPullRequestChangesDiff : openGitChangesDiff;
    return (
        <div className="git-changes-caption flex items-center justify-between pr-2 text-[10px] font-bold tracking-[0.06em] text-muted uppercase">
            <button
                type="button"
                className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1 border-0 bg-transparent px-2 text-left text-[10px] font-bold tracking-[0.06em] text-muted uppercase hover:text-foreground"
                aria-expanded={changesExpanded}
                onClick={onToggle}
            >
                {changesExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="truncate">
                    {pullRequest
                        ? `PR #${pullRequest.number} Changes`
                        : mode === 'commit'
                          ? latestCommit
                              ? `Commit ${latestCommit.commit.shortSha}`
                              : 'Last Commit'
                          : 'Changes'}
                </span>
            </button>
            <span className="git-changes-actions flex items-center gap-1">
                {mode === 'working' && (
                    <Tooltip content="Discard All Changes">
                        <Button
                            className="git-discard-all size-6"
                            size="icon"
                            variant="ghost"
                            aria-label="Discard All Changes"
                            disabled={repository.changedFileCount === 0}
                            onClick={() => {
                                // eslint-disable-next-line no-void -- intentional floating-promise discard, discardAllChanges reports its own errors via tryCommand
                                void discardAllChanges(sessionId, repository);
                            }}
                        >
                            <DiscardIcon size={13} />
                        </Button>
                    </Tooltip>
                )}
                {/* No aggregated commit-changes diff document exists yet, so the Open Changes
                    action stays hidden in commit mode. */}
                {mode !== 'commit' && (
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
                            disabled={filesCount === 0}
                            onClick={() => openChanges(repository.id, repository.name)}
                        >
                            <DiffMultipleIcon size={13} />
                        </Button>
                    </Tooltip>
                )}
                <span>{displayedCount}</span>
            </span>
        </div>
    );
}

export function GitRepoSection({
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
    const reduceMotion = useShouldReduceMotion();
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
    const headSha = repository.head;
    const latestCommitQuery = useCaxriQuery(
        'git.commitDetails',
        {
            sessionId,
            repositoryId: repository.id,
            // Placeholder satisfies the params schema while the query is disabled without a HEAD.
            sha: headSha ?? '0000000000000000000000000000000000000000',
        },
        { enabled: mode === 'commit' && Boolean(headSha) },
    );
    useToastOnQueryError(
        latestCommitQuery.isError,
        latestCommitQuery.error,
        'Last commit load failed',
    );
    const latestCommit = mode === 'commit' ? latestCommitQuery.data : undefined;
    const files =
        mode === 'working'
            ? repository.files
            : mode === 'commit'
              ? commitFilesToStatuses(latestCommit?.files ?? [])
              : (pullRequest?.files ?? []);
    /**
     * The working-tree count comes from `changedFileCount`, not `files.length`: the Runtime caps the transported
     * `files[]` payload at `MAX_GIT_STATUS_FILES`, so a very large change set can be truncated while `changedFileCount`
     * still reports its true, untruncated size — the same source the Status Bar reads through `git.overview`.
     */
    const displayedCount = mode === 'working' ? repository.changedFileCount : files.length;
    const selectedPath =
        mode === 'commit'
            ? activeDiff?.kind === 'commit-file' &&
              activeDiff.repositoryId === repository.id &&
              activeDiff.sha === headSha
                ? activeDiff.path
                : undefined
            : activeDiff?.kind === 'file' &&
                activeDiff.repositoryId === repository.id &&
                activeDiff.source === mode
              ? activeDiff.path
              : undefined;
    const openFile =
        mode === 'pull-request'
            ? openPullRequestFileDiff
            : mode === 'commit'
              ? (repoId: string, path: string): void => {
                    if (headSha) openGitCommitFileDiff(repoId, headSha, path);
                }
              : openGitFileDiff;
    const emptyMessage =
        mode === 'working'
            ? 'Working tree clean.'
            : mode === 'commit'
              ? !headSha
                  ? 'No commits yet.'
                  : latestCommitQuery.isError
                    ? 'Unable to load the last commit.'
                    : latestCommit === undefined
                      ? 'Loading last commit…'
                      : 'Last commit has no file changes.'
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
                // The jump-target flash tints the whole section with a translucent accent overlay
                // (an always-mounted pseudo-element whose opacity fades) so the eye lands on the
                // right section even when it was already expanded and nothing scrolled. The
                // overlay sits above the rows' own `bg-surface` fills, which would hide a plain
                // section background.
                "git-repository-section relative border-b border-border after:pointer-events-none after:absolute after:inset-0 after:z-10 after:bg-accent/10 after:opacity-0 after:content-['']",
                !reduceMotion && 'after:transition-opacity after:duration-500',
                flashed && 'after:opacity-100',
            )}
            data-git-repository-id={repository.id}
        >
            <GitRepoHeader
                displayedCount={displayedCount}
                expanded={expanded}
                latestCommit={latestCommit}
                mode={mode}
                pullRequest={pullRequest}
                repository={repository}
                sessionId={sessionId}
                onExpandedChange={onExpandedChange}
            />
            <DisclosureMotion animate expanded={expanded} kind="git-repository">
                {() => (
                    <div className="git-files overflow-visible">
                        <GitChangesCaption
                            changesExpanded={changesExpanded}
                            displayedCount={displayedCount}
                            filesCount={files.length}
                            latestCommit={latestCommit}
                            mode={mode}
                            pullRequest={pullRequest}
                            repository={repository}
                            sessionId={sessionId}
                            onToggle={() => setChangesExpanded((value) => !value)}
                        />
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
                                    {mode === 'commit' && latestCommit?.filesTruncated && (
                                        <div
                                            role="status"
                                            aria-live="polite"
                                            className="git-changes-truncated border-b border-border bg-surface px-3 py-1.5 text-[11px] text-muted"
                                        >
                                            Showing the first {latestCommit.files.length} files of
                                            this commit
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
                                            onDiscardFile={
                                                mode === 'working'
                                                    ? (file) => {
                                                          // eslint-disable-next-line no-void -- intentional floating-promise discard, discardFileChanges reports its own errors via tryCommand
                                                          void discardFileChanges(
                                                              sessionId,
                                                              repository,
                                                              file,
                                                          );
                                                      }
                                                    : undefined
                                            }
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
