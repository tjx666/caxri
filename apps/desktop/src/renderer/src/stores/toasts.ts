import { errorMessage, isCaxriError } from '@caxri/protocol';
import type { ToastT } from 'sonner';
import { toast } from 'sonner';

export type ToastKind = 'info' | 'success' | 'error';

interface ToastAction {
    label: string;
    onSelect: () => void;
}

export interface ToastOptions {
    /**
     * Keeps a notification on screen until the user dismisses it. Reserved for events that already cost the user
     * something irreversible — an external write replacing an unsaved buffer — where a 4-second auto-dismiss can
     * silently take the only record of it away.
     */
    persist?: boolean;
    /**
     * Optional immediate follow-up rendered as a keyboard-accessible button.
     */
    action?: ToastAction;
}

/**
 * Reads Sonner's active notifications without maintaining a second queue.
 */
export function getToasts(): ToastT[] {
    return toast.getToasts().filter((entry): entry is ToastT => !('dismiss' in entry));
}

/**
 * Keeps command callers independent of rendering. Consecutive identical events update the live notification through
 * Sonner's id API; Sonner owns expiration, interaction pauses, and removal.
 */
export function pushToast(kind: ToastKind, message: string, options?: ToastOptions): void {
    const newest = getToasts().at(-1);
    const id = newest?.type === kind && newest.title === message ? newest.id : undefined;
    toast[kind](message, {
        id,
        duration: options?.persist ? Infinity : 4_000,
        action: options?.action
            ? { label: options.action.label, onClick: options.action.onSelect }
            : undefined,
    });
}

/**
 * Dismisses one notification, or all notifications when no id is supplied.
 */
export function dismissToast(id?: number | string): void {
    toast.dismiss(id);
}

/**
 * Renders any rejection as one sentence. `CaxriError` messages are already user-facing, so the code is only consulted
 * for the classifications whose message alone does not explain what to do next.
 */
export function describeFailure(error: unknown, label: string): string {
    if (isCaxriError(error)) {
        if (error.code === 'UNAVAILABLE') return `${label}: Caxri is not ready yet.`;
        if (error.code === 'TIMEOUT') return `${label}: Caxri did not respond in time.`;
        return error.message;
    }
    return errorMessage(error, label);
}

export interface TryCommandOptions {
    /**
     * Re-reads the Server snapshot after the operation succeeds.
     */
    refresh?: () => Promise<void>;
}

/**
 * The single failure funnel for Renderer-initiated Server work: awaits `run`, optionally refreshes the workbench
 * snapshot, and turns any rejection into exactly one error toast. Replaces the `.catch(error => showMessage(error
 * instanceof Error ? error.message : '…'))` chain that used to be copy-pasted at every call site.
 */
export async function tryCommand<T>(
    label: string,
    run: () => Promise<T>,
    options: TryCommandOptions = {},
): Promise<T | undefined> {
    try {
        const result = await run();
        if (options.refresh) await options.refresh();
        return result;
    } catch (error) {
        pushToast('error', describeFailure(error, label));
        return undefined;
    }
}
