import { AlertTriangle } from 'lucide-react';

import { LoadingSkeleton } from '../../../components/loading-skeleton';
import { Button } from '../../../components/ui/button';
import { useTranslation } from '../../../i18n';
import type { ExtensionFailureReason } from '../extension-failure';
import { describeExtensionFailureReason } from '../extension-failure';
import { ExtensionTreeMessage } from './extension-tree-message';
import type { VisiblePlaceholderRow } from './rows';
import { loadingPlaceholderDepths } from './rows';

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
    if (row.kind === 'error') {
        // A failed root renders as the view-wide ExtensionTreeMessage instead; this row is a nested branch's failure, so
        // it stays one line: the closed reason in the muted tone, with the danger tone kept to the icon.
        const reason = describeExtensionFailureReason(row.reason, t);
        return (
            <div
                className="flex h-7 items-center gap-2 pr-1 text-muted"
                role="status"
                style={{ paddingLeft }}
            >
                <AlertTriangle className="shrink-0 text-danger" size={14} />
                <span className="min-w-0 flex-1 truncate">{reason}</span>
                <Button size="sm" variant="ghost" onClick={onRetry}>
                    {t('common.retry')}
                </Button>
            </div>
        );
    }
    return (
        <div className="flex h-7 items-center text-muted" role="status" style={{ paddingLeft }}>
            {t('viewContainers.extensionTree.empty')}
        </div>
    );
}

/**
 * A failed root has no rows to place a placeholder beside, so it takes the whole view as the shared message state
 * (DESIGN.md: never a long error forced into a single data row). The caller renders it outside `role="tree"`, because
 * its Retry is a focusable control that is not a row.
 */
export function ExtensionTreeRootFailure({
    isRetrying,
    onRetry,
    reason,
    title,
}: {
    isRetrying: boolean;
    onRetry: () => void;
    reason: ExtensionFailureReason;
    title: string;
}) {
    const { t } = useTranslation();
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto" role="status">
            <ExtensionTreeMessage
                isActionFocusable
                actionLabel={t('common.retry')}
                description={describeExtensionFailureReason(reason, t)}
                disabled={isRetrying}
                icon={<AlertTriangle className="text-danger" size={24} />}
                title={t('viewContainers.extensionTree.loadFailed', { title })}
                onAction={onRetry}
            />
        </div>
    );
}
