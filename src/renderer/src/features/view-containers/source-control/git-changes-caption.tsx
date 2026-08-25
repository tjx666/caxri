import { ChevronDown, ChevronRight } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { DiffMultipleIcon } from '../../../icons/codicons/diff-multiple-icon';
import { DiscardIcon } from '../../../icons/codicons/discard-icon';
import type { GitRepoSectionController } from './use-git-repo-section-controller';

export function GitChangesCaption({ controller }: { controller: GitRepoSectionController }) {
    const {
        changesExpanded,
        discardAll,
        displayedCount,
        files,
        latestCommit,
        mode,
        openChanges,
        pullRequest,
        repository,
        toggleChangesExpanded,
    } = controller;

    return (
        <div className="git-changes-caption flex items-center justify-between pr-2 text-[10px] font-bold tracking-[0.06em] text-muted uppercase">
            <button
                type="button"
                className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1 border-0 bg-transparent px-2 text-left text-[10px] font-bold tracking-[0.06em] text-muted uppercase hover:text-foreground"
                aria-expanded={changesExpanded}
                onClick={toggleChangesExpanded}
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
                            onClick={discardAll}
                        >
                            <DiscardIcon size={13} />
                        </Button>
                    </Tooltip>
                )}
                {/* No aggregated commit-changes diff document exists, so this stays hidden in commit mode. */}
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
                            disabled={files.length === 0}
                            onClick={openChanges}
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
