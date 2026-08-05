import { dismissToast, useToastStore } from '../../state/toasts';

/**
 * Single notification surface. Errors have no auto-expiry, so clicking the toast dismisses it; the
 * element itself is unchanged so existing selectors and styling still apply.
 */
export function ToastOutlet() {
    const toast = useToastStore((state) => state.toast);
    if (!toast) return null;
    return (
        <div className="toast" role="status" onClick={dismissToast}>
            {toast.message}
        </div>
    );
}
