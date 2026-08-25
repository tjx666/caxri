import type { SourceControlAction, SourceControlHistoryDescriptor } from '@shared/views';

import { describeFailure } from '../../../stores/toasts';
import { useSourceControlHistoryDetails } from './hooks/use-source-control-history-details';

export function SourceControlHistoryDetails({
    descriptor,
    itemId,
    path,
    runAction,
}: {
    descriptor: SourceControlHistoryDescriptor;
    itemId: string;
    path?: string;
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
                {descriptor.detailsLabel} · {details.data.resources.length}
            </div>
            {details.data.resources.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-muted">
                    {descriptor.detailsEmptyMessage}
                </div>
            ) : (
                details.data.resources.map((resource) => (
                    <button
                        type="button"
                        className="flex min-h-6 w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 text-left text-[11px] text-foreground hover:bg-elevated"
                        key={resource.id}
                        aria-label={resource.accessibilityLabel}
                        title={resource.tooltip}
                        onClick={() => resource.action && runAction(resource.action)}
                    >
                        <span className="w-14 shrink-0 text-muted">{resource.description}</span>
                        <span className="truncate">{resource.path}</span>
                    </button>
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
            <span className="text-success">+{details.data.additions}</span>
            <span className="text-danger">-{details.data.deletions}</span>
        </>
    );
}
