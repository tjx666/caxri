import { useTranslation } from '../../../i18n';
import type { PendingFileOperation } from './file-operation-state';

export interface PendingFileOperationStatusProperties {
    isCancelRevealed: boolean;
    onCancel: () => void;
    operation: PendingFileOperation;
}

export function PendingFileOperationStatus({
    isCancelRevealed,
    onCancel,
    operation,
}: PendingFileOperationStatusProperties) {
    const { t } = useTranslation();
    return (
        <div
            role="status"
            aria-live="polite"
            className="flex items-center justify-between gap-2 border-b border-border bg-surface px-2 py-1 text-[11px] text-muted"
        >
            <span className="truncate">{operation.label}</span>
            {isCancelRevealed && (
                <button
                    className="shrink-0 text-foreground underline decoration-dotted underline-offset-2 hover:text-accent"
                    type="button"
                    onClick={onCancel}
                >
                    {t('common.cancel')}
                </button>
            )}
        </div>
    );
}
