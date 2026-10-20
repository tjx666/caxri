import { AlertTriangle } from 'lucide-react';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import type { VisiblePlaceholderRow } from './extension-tree-rows';
import { loadingPlaceholderDepths } from './extension-tree-rows';

/**
 * A lazy branch's loading, error, and empty states, rendered where that branch's children would be. Loading draws
 * skeleton rows sized by `loadingPlaceholderRowCount`, which the virtualizer's row estimate reads too.
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
    const { t } = useTranslation();
    if (row.kind === 'loading')
        return (
            <LoadingSkeleton
                variant="list"
                indent={8 + row.depth * 14}
                label={t('viewContainers.extensionTree.loading')}
                depths={loadingPlaceholderDepths(row)}
            />
        );
    const paddingLeft = `${8 + row.depth * 14}px`;
    if (row.kind === 'error')
        return (
            <div
                className="flex h-7 items-center gap-2 text-danger"
                role="status"
                style={{ paddingLeft }}
            >
                <AlertTriangle size={14} />
                <span className="min-w-0 flex-1 truncate">
                    {t('viewContainers.extensionTree.loadFailed', { message: row.message })}
                </span>
                <Button size="sm" variant="ghost" onClick={onRetry}>
                    {t('common.retry')}
                </Button>
            </div>
        );
    return (
        <div className="flex h-7 items-center text-muted" role="status" style={{ paddingLeft }}>
            {t('viewContainers.extensionTree.empty')}
        </div>
    );
}
