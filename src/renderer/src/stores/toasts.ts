import { create } from 'zustand';

import { errorMessage, isCaxriError } from '@shared/ipc';

import { refreshWorkbench } from './workbench';

export type ToastKind = 'info' | 'success' | 'error';

interface Toast {
    id: number;
    kind: ToastKind;
    message: string;
    /** Stays on screen until dismissed, like an error, without claiming the failure styling. */
    persist: boolean;
}

export interface ToastOptions {
    /**
     * Keeps a non-error notification on screen until the user dismisses it. Reserved for events
     * that already cost the user something irreversible — an external write replacing an unsaved
     * buffer — where a 4-second auto-dismiss can silently take the only record of it away.
     */
    persist?: boolean;
}

/** Matches the previous inline `showMessage` timeout so notification timing is unchanged. */
const AUTO_DISMISS_MS = 4_000;
/**
 * The stack sits above the status bar in the bottom-right corner; more than three at once turns a
 * notification into a wall, so the oldest is dropped to make room.
 */
const MAX_VISIBLE_TOASTS = 3;

interface ToastState {
    /** Oldest first, so the newest notification renders closest to the status bar. */
    toasts: Toast[];
    push(kind: ToastKind, message: string, options?: ToastOptions): void;
    /** Dismisses one notification by id, or every notification when the id is omitted. */
    dismiss(id?: number): void;
}

const dismissTimers = new Map<number, number>();
let nextToastId = 0;

function clearDismissTimer(id: number): void {
    const timer = dismissTimers.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    dismissTimers.delete(id);
}

export const useToastStore = create<ToastState>((set, get) => ({
    toasts: [],
    push(kind, message, options) {
        const persist = kind === 'error' || options?.persist === true;
        /**
         * A single user-visible event can arrive twice — a file watcher reports a write and the
         * follow-up metadata change, for instance. Replacing one toast with the next used to hide
         * that; a stack would show the same sentence twice, so a repeat re-arms the live one.
         */
        const newest = get().toasts.at(-1);
        if (newest && newest.kind === kind && newest.message === message) {
            clearDismissTimer(newest.id);
            if (!persist)
                dismissTimers.set(
                    newest.id,
                    window.setTimeout(() => get().dismiss(newest.id), AUTO_DISMISS_MS),
                );
            return;
        }
        const id = ++nextToastId;
        set((state) => {
            const next = [...state.toasts, { id, kind, message, persist }];
            for (const dropped of next.splice(0, Math.max(0, next.length - MAX_VISIBLE_TOASTS)))
                clearDismissTimer(dropped.id);
            return { toasts: next };
        });
        /** Failures and opted-in notices stay until dismissed; progress notifications self-expire. */
        if (!persist)
            dismissTimers.set(
                id,
                window.setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS),
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
 * Renders any rejection as one sentence. `CaxriError` messages are already user-facing, so the code
 * is only consulted for the classifications whose message alone does not explain what to do next.
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
    /** Re-reads the Runtime snapshot after the operation succeeds. */
    refresh?: boolean;
}

/**
 * The single failure funnel for Renderer-initiated Runtime work: awaits `run`, optionally refreshes
 * the workbench snapshot, and turns any rejection into exactly one error toast. Replaces the
 * `.catch(error => showMessage(error instanceof Error ? error.message : '…'))` chain that used to be
 * copy-pasted at every call site.
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
