import type { SourceControlAction, SourceControlViewModel } from '@caxri/protocol';
import { GitBranch, GitCommitHorizontal } from 'lucide-react';

import { executeCommand } from '../../../commands/execute';
import { StructuredTooltip } from '../../../components/structured-tooltip';
import { cn } from '../../../lib/utilities';
import { branchRowInteraction, branchRowTooltipDetails } from './source-control-row-labels';
import { sourceControlActionMenuItems } from './source-control-row-menu';
import { SourceControlTreeRow } from './source-control-tree-row';

type ProviderModel = SourceControlViewModel['providers'][number];

/**
 * The repository's branch (or whatever reference the provider describes) as the section's first child row, laid out on
 * the directory rows' grid: the same height, padding, base text, a glyph in their file-icon column, and an optional
 * trailing status such as `↑2 ↓1` in their right-aligned `+N -M` column. Like the status bar's branch item, activating
 * the primary repository's row opens the branch picker, and clicking the ahead/behind badge runs the repository's sync
 * action. The badge is not its own button: a treeitem cannot nest one, so keyboard users reach sync through the row's
 * `Shift+F10` menu and the provider header's Sync button. An empty description means the provider judged the row
 * redundant with the header, and it is omitted.
 */
export function SourceControlBranchRow({
    provider,
    runAction,
}: {
    provider: ProviderModel;
    runAction: (action: SourceControlAction) => void;
}) {
    if (!provider.description) return null;
    const Icon = provider.descriptionKind === 'commit' ? GitCommitHorizontal : GitBranch;
    const { canSwitchBranch, hints, syncAction } = branchRowInteraction(provider);
    const isInteractive = canSwitchBranch || Boolean(syncAction);
    return (
        <SourceControlTreeRow
            rowId={`provider-branch:${provider.id}`}
            level={2}
            className={cn(
                'git-repository-branch-row flex h-7 w-full min-w-0 items-center gap-1.5 border-0 bg-surface pr-2 pl-2 text-left text-foreground',
                isInteractive ? 'cursor-pointer hover:bg-elevated' : 'cursor-default',
            )}
            aria-description={hints.join('. ') || undefined}
            tooltip={
                <StructuredTooltip
                    title={provider.description}
                    details={branchRowTooltipDetails(
                        provider.description,
                        provider.descriptionTooltip,
                    )}
                    hint={hints.length > 0 ? hints : undefined}
                />
            }
            menuItems={[
                ...(canSwitchBranch
                    ? [
                          {
                              id: 'switch-branch',
                              label: 'Switch Branch…',
                              run: () => executeCommand('git.switchBranch'),
                          },
                      ]
                    : []),
                ...sourceControlActionMenuItems(syncAction && [syncAction], runAction),
            ]}
            onClick={(event) => {
                const isOnBadge =
                    event.target instanceof Element &&
                    event.target.closest('[data-branch-sync-badge]') !== null;
                if (isOnBadge && syncAction) {
                    runAction(syncAction);
                    return;
                }
                if (canSwitchBranch) executeCommand('git.switchBranch');
            }}
        >
            {/* Empty chevron column: the row never expands, and the glyph and name line up with the directory rows'. */}
            <span aria-hidden="true" className="w-[13px] flex-none" />
            <span className="flex size-4 flex-none items-center justify-center text-muted">
                <Icon aria-hidden="true" size={14} />
            </span>
            <span
                className="git-repository-meta flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
                aria-label={provider.descriptionAccessibilityLabel}
            >
                <span className="git-repository-branch min-w-0 flex-1 truncate">
                    {provider.description}
                </span>
                {provider.descriptionBadge && (
                    <span
                        className={cn(
                            'git-repository-branch-badge shrink-0 text-[11px] whitespace-nowrap text-muted tabular-nums',
                            syncAction && 'hover:text-foreground',
                        )}
                        data-branch-sync-badge={syncAction ? '' : undefined}
                    >
                        {provider.descriptionBadge}
                    </span>
                )}
            </span>
            {/* Stands in for a file row's status letter, as on directory rows, so the badge shares the counts' column. */}
            {provider.descriptionBadge && (
                <span aria-hidden="true" className="ml-0.5 w-4 flex-none" />
            )}
        </SourceControlTreeRow>
    );
}
