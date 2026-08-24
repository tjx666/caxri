import { ChevronDown, ChevronRight, FolderGit2 } from 'lucide-react';

import { Button } from '../../../../components/ui/button';
import { Tooltip } from '../../../../components/ui/tooltip';
import { FileSubmoduleIcon } from '../../../../icons/codicons/file-submodule-icon';
import { SyncIcon } from '../../../../icons/codicons/sync-icon';
import { describeAheadBehind, describePullRequestSummary } from './git-repo-summary-text';
import type { GitRepoSectionController } from './use-git-repo-section-controller';

export function GitRepoHeader({ controller }: { controller: GitRepoSectionController }) {
    const {
        displayedCount,
        expanded,
        latestCommit,
        mode,
        pullRequest,
        repository,
        sync,
        syncing,
        toggleExpanded,
    } = controller;

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
                onClick={toggleExpanded}
            >
                <span className="git-repository-identity flex shrink-0 items-center gap-1">
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    {/* The mark names what the row is — a repository — while the segmented control owns mode. */}
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
                    aria-label={
                        pullRequest
                            ? describePullRequestSummary(pullRequest)
                            : describeAheadBehind(repository.ahead, repository.behind)
                    }
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
                        onClick={sync}
                    >
                        <SyncIcon size={13} className={syncing ? 'animate-spin' : undefined} />
                    </Button>
                </Tooltip>
            )}
        </div>
    );
}
