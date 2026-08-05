import { CircleCheck, CircleX, Info, X } from 'lucide-react';

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
        <div className="toast-stack" role="status" aria-live="polite">
            {toasts.map((toast) => {
                const Icon = TOAST_ICONS[toast.kind];
                return (
                    <div
                        key={toast.id}
                        className={`toast toast-${toast.kind}`}
                        onClick={() => dismissToast(toast.id)}
                    >
                        <Icon className="toast-icon" size={14} aria-hidden="true" />
                        <span className="toast-message">{toast.message}</span>
                        <button
                            type="button"
                            className="toast-dismiss"
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
