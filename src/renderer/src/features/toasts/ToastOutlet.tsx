import { CircleCheck, CircleX, Info, X } from 'lucide-react';

import { cn } from '../../lib/utils';
import { dismissToast, useToastStore, type ToastKind } from '../../state/toasts';

const TOAST_ICONS: Record<ToastKind, typeof Info> = {
    error: CircleX,
    info: Info,
    success: CircleCheck,
};

/**
 * The notification stack. Errors have no auto-expiry, so every toast carries an explicit dismiss
 * control; clicking the body still dismisses it, which is how the surface behaved before.
 */
export function ToastOutlet() {
    const toasts = useToastStore((state) => state.toasts);
    if (toasts.length === 0) return null;
    return (
        <div
            className="fixed right-4 bottom-10 z-[80] flex flex-col items-end gap-2"
            role="status"
            aria-live="polite"
        >
            {toasts.map((toast) => {
                const Icon = TOAST_ICONS[toast.kind];
                return (
                    <div
                        key={toast.id}
                        className={cn(
                            'toast',
                            'flex max-w-[460px] items-start gap-2 rounded-md border border-border border-l-[3px] border-l-muted bg-elevated px-3 py-2 text-left shadow-[0_8px_24px_var(--shadow)]',
                            toast.kind === 'success' && 'border-l-success',
                            toast.kind === 'error' && 'border-l-danger',
                        )}
                        onClick={() => dismissToast(toast.id)}
                    >
                        <Icon
                            className={cn(
                                'mt-px flex-none text-muted',
                                toast.kind === 'success' && 'text-success',
                                toast.kind === 'error' && 'text-danger',
                            )}
                            size={14}
                            aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                            {toast.message}
                        </span>
                        <button
                            type="button"
                            className="grid size-4 flex-none place-items-center rounded border-0 bg-transparent p-0 text-muted hover:bg-[var(--selection)] hover:text-foreground"
                            aria-label="Dismiss notification"
                            onClick={() => dismissToast(toast.id)}
                        >
                            <X size={12} aria-hidden="true" />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
