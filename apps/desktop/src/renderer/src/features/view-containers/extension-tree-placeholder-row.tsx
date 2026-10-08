import { AlertTriangle } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import type { VisiblePlaceholderRow } from './extension-tree-rows';

/**
 * A lazy branch's loading, error, and empty states, rendered where that branch's children would be.
 *
 * `role="status"` is the announcement these states want: the same notice role the multi-file diff's exclusion banner
 * uses. It is not the row's own role: the caller wraps this in a disabled `treeitem`, because `role="tree"` admits only
 * `treeitem` and `group` as children, and `isNavigableExtensionTreeRow` keeps arrow keys stepping straight over it so
 * focus never parks on text it cannot act on.
 */
export function ExtensionTreePlaceholderRow({
    row,
    onRetry,
}: {
    onRetry: () => void;
    row: VisiblePlaceholderRow;
}) {
    const paddingLeft = `${8 + row.depth * 14}px`;
    if (row.kind === 'loading')
        return (
            <div
                className="flex h-7 items-center gap-2 text-muted"
                role="status"
                style={{ paddingLeft }}
            >
                <Spinner aria-hidden="true" className="size-3.5" /> Loading view…
            </div>
        );
    if (row.kind === 'error')
        return (
            <div
                className="flex h-7 items-center gap-2 text-danger"
                role="status"
                style={{ paddingLeft }}
            >
                <AlertTriangle size={14} />
                <span className="min-w-0 flex-1 truncate">Unable to load view: {row.message}</span>
                <Button size="sm" variant="ghost" onClick={onRetry}>
                    Retry
                </Button>
            </div>
        );
    return (
        <div className="flex h-7 items-center text-muted" role="status" style={{ paddingLeft }}>
            No items in this view.
        </div>
    );
}
