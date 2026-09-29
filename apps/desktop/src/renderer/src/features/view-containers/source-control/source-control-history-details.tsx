import type { SourceControlAction, SourceControlHistoryDescriptor } from '@caxri/protocol';

import { describeFailure } from '../../../stores/toasts';
import { useSourceControlHistoryDetails } from './hooks/use-source-control-history-details';
import { SourceControlTreeRow } from './source-control-tree-row';

/**
 * One commit's changed files, expanded under its commit row inside the Source Control `role="tree"`.
 *
 * `level` is the `aria-level` for the file rows, one deeper than the commit row they hang off, and `rowIdPrefix`
 * namespaces their row ids within the tree's single roving tabindex.
 */
export function SourceControlHistoryDetails({
    descriptor,
    itemId,
    level,
    path,
    rowIdPrefix,
    runAction,
}: {
    descriptor: SourceControlHistoryDescriptor;
    itemId: string;
    level: number;
    path?: string;
    rowIdPrefix: string;
    runAction: (action: SourceControlAction) => void;
}) {
    const details = useSourceControlHistoryDetails(descriptor, itemId, path);
    if (details.isPending)
        return (
            <div className="px-3 py-2 text-[11px] text-muted">
                {descriptor.detailsLoadingMessage}
            </div>
        );
    if (details.isError)
        return (
            <div className="px-3 py-2 text-[11px] text-danger">
                {describeFailure(details.error, descriptor.detailsErrorMessage)}
            </div>
        );
    return (
        <div className="commit-details border-y border-border bg-background py-1">
            <div className="px-3 py-1 text-[10px] font-bold tracking-[0.06em] text-muted uppercase">
                {descriptor.detailsLabel} ·{' '}
                {details.data.resources.length + (details.data.hiddenCount ?? 0)}
                {!!details.data.hiddenCount && ` · ${details.data.hiddenCount} hidden`}
            </div>
            {details.data.resources.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-muted">
                    {details.data.hiddenCount
                        ? details.data.summary
                        : descriptor.detailsEmptyMessage}
                </div>
            ) : (
                details.data.resources.map((resource) => (
                    <SourceControlTreeRow
                        key={resource.id}
                        rowId={`${rowIdPrefix}:file:${resource.id}`}
                        level={level}
                        className="flex min-h-6 w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 text-left text-[11px] text-foreground hover:bg-elevated"
                        aria-label={resource.accessibilityLabel}
                        title={resource.tooltip}
                        onClick={() => resource.action && runAction(resource.action)}
                    >
                        <span className="w-14 shrink-0 text-muted">{resource.description}</span>
                        <span className="truncate">{resource.path}</span>
                    </SourceControlTreeRow>
                ))
            )}
            {details.data.truncated && (
                <div className="px-3 py-1 text-[11px] text-warning">
                    {descriptor.detailsTruncatedMessage}
                </div>
            )}
        </div>
    );
}

/**
 * Mounted only with the hover content, preserving lazy details reads for retained history rows.
 */
export function SourceControlHistoryHoverDetails({
    descriptor,
    itemId,
    path,
}: {
    descriptor: SourceControlHistoryDescriptor;
    itemId: string;
    path?: string;
}) {
    const details = useSourceControlHistoryDetails(descriptor, itemId, path);
    if (!details.data) return null;
    return (
        <>
            <span className="text-muted">{details.data.summary}</span>
            <span className="diff-stat text-success">+{details.data.additions}</span>
            <span className="diff-stat text-danger">−{details.data.deletions}</span>
        </>
    );
}
