import { FileDiff, GitCommitHorizontal, GitPullRequest, RefreshCw } from 'lucide-react';

import { executeCommand } from '../../../commands/execute';
import { PanelHeader } from '../../../components/panel-header';
import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { cn } from '../../../lib/utilities';
import { useControlledViewActionCommand } from '../controlled-view-context';
import type { SourceControlViewMode } from './source-control-state';

interface SourceControlHeaderProperties {
    mode: SourceControlViewMode;
}

export function SourceControlHeader({ mode }: SourceControlHeaderProperties) {
    const workingTreeCommand = useControlledViewActionCommand('source.workingTree');
    const lastCommitCommand = useControlledViewActionCommand('source.lastCommit');
    const pullRequestCommand = useControlledViewActionCommand('source.pullRequest');
    const refreshCommand = useControlledViewActionCommand('source.refresh');
    const run = (command: string | undefined): void => {
        if (command) executeCommand(command);
    };
    return (
        <PanelHeader
            className="git-heading"
            title="Source Control"
            actions={
                <>
                    <div
                        className="git-mode-switch flex h-7 items-center rounded-md bg-elevated p-0.5"
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
                                onClick={() => run(workingTreeCommand)}
                            >
                                {/* A working-tree change set is a diff, not a branch: the branch mark already labels
                                    the Git tab and every repository row. */}
                                <FileDiff size={13} />
                            </button>
                        </Tooltip>
                        <Tooltip content="Last Commit Changes">
                            <button
                                type="button"
                                className={cn(
                                    'grid size-6 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted hover:text-foreground',
                                    mode === 'commit' && 'bg-surface text-foreground',
                                )}
                                aria-label="Last Commit Changes"
                                aria-pressed={mode === 'commit'}
                                onClick={() => run(lastCommitCommand)}
                            >
                                <GitCommitHorizontal size={13} />
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
                                onClick={() => run(pullRequestCommand)}
                            >
                                <GitPullRequest size={13} />
                            </button>
                        </Tooltip>
                    </div>
                    <Tooltip
                        content={mode === 'pull-request' ? 'Refresh Pull Request' : 'Refresh Git'}
                    >
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label={
                                mode === 'pull-request' ? 'Refresh Pull Request' : 'Refresh Git'
                            }
                            onClick={() => run(refreshCommand)}
                        >
                            <RefreshCw size={13} />
                        </Button>
                    </Tooltip>
                </>
            }
        />
    );
}
