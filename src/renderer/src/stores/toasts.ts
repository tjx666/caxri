import { errorMessage, isCaxriError } from '@caxri/protocol';
import { create } from 'zustand';

import { refreshWorkbench } from './workbench';

export type ToastKind = 'info' | 'success' | 'error';

interface ToastAction {
    label: string;
    onSelect: () => void;
}

interface Toast {
    id: number;
    kind: ToastKind;
    message: string;
    /**
     * Stays on screen until dismissed, like an error, without claiming the failure styling.
     */
    persist: boolean;
    action?: ToastAction;
}

export interface ToastOptions {
    /**
     * Keeps a non-error notification on screen until the user dismisses it. Reserved for events that already cost the
     * user something irreversible — an external write replacing an unsaved buffer — where a 4-second auto-dismiss can
     * silently take the only record of it away.
     */
    persist?: boolean;
    /**
     * Optional immediate follow-up rendered as a keyboard-accessible button.
     */
    action?: ToastAction;
}

/**
 * Matches the previous inline `showMessage` timeout so notification timing is unchanged.
 */
const AUTO_DISMISS_MS = 4_000;
/**
 * The stack sits above the status bar in the bottom-right corner; more than three at once turns a notification into a
 * wall, so the oldest is dropped to make room.
 */
const MAX_VISIBLE_TOASTS = 3;

interface ToastState {
    /**
     * Oldest first, so the newest notification renders closest to the status bar.
     */
    toasts: Toast[];
    push(kind: ToastKind, message: string, options?: ToastOptions): void;
    /**
     * Dismisses one notification by id, or every notification when the id is omitted.
     */
    dismiss(id?: number): void;
}

const dismissTimers = new Map<number, number>();
// Mutated via a property (not a bare top-level `let`) so incrementing it from inside store
// actions satisfies unicorn/no-top-level-assignment-in-function.
const toastIdCounter = { current: 0 };

function clearDismissTimer(id: number): void {
    const timer = dismissTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    dismissTimers.delete(id);
}

export const useToastStore = create<ToastState>((set, get) => ({
    toasts: [],
    push(kind, message, options) {
        const isPersist = kind === 'error' || options?.persist === true;
        /**
         * A single user-visible event can arrive twice — a file watcher reports a write and the follow-up metadata
         * change, for instance. Replacing one toast with the next used to hide that; a stack would show the same
         * sentence twice, so a repeat re-arms the live one.
         */
        const newest = get().toasts.at(-1);
        if (newest?.kind === kind && newest.message === message) {
            clearDismissTimer(newest.id);
            if (!isPersist)
                dismissTimers.set(
                    newest.id,
                    setTimeout(() => get().dismiss(newest.id), AUTO_DISMISS_MS),
                );
            return;
        }
        toastIdCounter.current += 1;
        const id = toastIdCounter.current;
        set((state) => {
            const next = [
                ...state.toasts,
                { id, kind, message, persist: isPersist, action: options?.action },
            ];
            const overflow = next.splice(0, Math.max(0, next.length - MAX_VISIBLE_TOASTS));
            for (const dropped of overflow) clearDismissTimer(dropped.id);
            return { toasts: next };
        });
        /**
         * Failures and opted-in notices stay until dismissed; progress notifications self-expire.
         */
        if (!isPersist)
            dismissTimers.set(
                id,
                setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS),
            );
    },
    dismiss(id) {
        if (id === undefined) {
            for (const toast of get().toasts) clearDismissTimer(toast.id);
            set({ toasts: [] });
            return;
        }
        clearDismissTimer(id);
        set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    },
}));

export function pushToast(kind: ToastKind, message: string, options?: ToastOptions): void {
    useToastStore.getState().push(kind, message, options);
}

export function dismissToast(id?: number): void {
    useToastStore.getState().dismiss(id);
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
     * Re-reads the Runtime snapshot after the operation succeeds.
     */
    refresh?: boolean;
}

/**
 * The single failure funnel for Renderer-initiated Runtime work: awaits `run`, optionally refreshes the workbench
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
        if (options.refresh) await refreshWorkbench();
        return result;
    } catch (error) {
        pushToast('error', describeFailure(error, label));
        return undefined;
    }
}
