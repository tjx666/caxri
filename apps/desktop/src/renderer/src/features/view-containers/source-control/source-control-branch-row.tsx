import type { SourceControlViewModel } from '@caxri/protocol';
import { GitBranch, GitCommitHorizontal } from 'lucide-react';

import { StructuredTooltip } from '../../../components/structured-tooltip';
import { SourceControlTreeRow } from './source-control-tree-row';

type ProviderModel = SourceControlViewModel['providers'][number];

/**
 * The repository's branch (or whatever reference the provider describes) as the section's first child row, laid out on
 * the directory rows' grid: the same height, padding, base text, a glyph in their file-icon column, and an optional
 * trailing status such as `↑2 ↓1` in their right-aligned `+N -M` column. It carries no action of its own, so it has no
 * hover fill; hovering or focusing it shows the same detail the header tooltip does. An empty description means the
 * provider judged the row redundant with the header, and it is omitted.
 */
export function SourceControlBranchRow({ provider }: { provider: ProviderModel }) {
    if (!provider.description) return null;
    const Icon = provider.descriptionKind === 'commit' ? GitCommitHorizontal : GitBranch;
    return (
        <SourceControlTreeRow
            rowId={`provider-branch:${provider.id}`}
            level={2}
            className="git-repository-branch-row flex h-7 w-full min-w-0 cursor-default items-center gap-1.5 border-0 bg-surface pr-2 pl-2 text-left text-foreground"
            tooltip={
                <StructuredTooltip
                    title={provider.description}
                    details={[provider.descriptionTooltip]}
                />
            }
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
                    <span className="git-repository-branch-badge shrink-0 text-[11px] whitespace-nowrap text-muted tabular-nums">
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
