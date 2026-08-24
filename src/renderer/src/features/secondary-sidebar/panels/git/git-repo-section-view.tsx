import { DisclosureMotion } from '../../../../components/disclosure-motion';
import { Empty } from '../../../../components/ui/empty';
import { cn } from '../../../../lib/utilities';
import { CommitHistory } from './commit-history';
import { GitChangesCaption } from './git-changes-caption';
import { GitRepoHeader } from './git-repo-header';
import { GitTreeItems } from './git-tree-items';
import type { GitRepoSectionController } from './use-git-repo-section-controller';

export function GitRepoSectionView({ controller }: { controller: GitRepoSectionController }) {
    const {
        buildTreeNodes,
        changesExpanded,
        discardFile,
        emptyMessage,
        expanded,
        expandedDirectories,
        files,
        flashed,
        latestCommit,
        mode,
        onFocusRepository,
        reduceMotion,
        repository,
        selectedPath,
        sessionId,
        setDirectoryExpanded,
        submodulesByPath,
    } = controller;

    return (
        <section
            className={cn(
                // The jump-target flash tints the whole section above row backgrounds so the eye lands on the target.
                "git-repository-section relative border-b border-border after:pointer-events-none after:absolute after:inset-0 after:z-10 after:bg-accent/10 after:opacity-0 after:content-['']",
                !reduceMotion && 'after:transition-opacity after:duration-500',
                flashed && 'after:opacity-100',
            )}
            data-git-repository-id={repository.id}
        >
            <GitRepoHeader controller={controller} />
            <DisclosureMotion animate expanded={expanded} kind="git-repository">
                {() => (
                    <div className="git-files overflow-visible">
                        <GitChangesCaption controller={controller} />
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
                                            nodes={buildTreeNodes()}
                                            repositoryKey={`${mode}:${repository.id}`}
                                            selected={selectedPath}
                                            setDirectoryExpanded={setDirectoryExpanded}
                                            submodulesByPath={submodulesByPath}
                                            onDiscardFile={
                                                mode === 'working' ? discardFile : undefined
                                            }
                                            onFocusRepository={onFocusRepository}
                                            onSelect={controller.openFile}
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
