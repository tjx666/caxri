import { create } from 'zustand';

import { isCaxriError } from '@shared/ipc';

import { refreshWorkbench } from './workbench';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
    id: number;
    kind: ToastKind;
    message: string;
}

/** Matches the previous inline `showMessage` timeout so notification timing is unchanged. */
const AUTO_DISMISS_MS = 4_000;

interface ToastState {
    /**
     * One visible notification at a time: `.toast` is a fixed-position element in the bottom-right
     * corner, so stacking would overlap. A newer notification replaces the current one.
     */
    toast?: Toast;
    push(kind: ToastKind, message: string): void;
    dismiss(id?: number): void;
}

let dismissTimer: number | undefined;
let nextToastId = 0;

function clearDismissTimer(): void {
    if (dismissTimer !== undefined) window.clearTimeout(dismissTimer);
    dismissTimer = undefined;
}

export const useToastStore = create<ToastState>((set, get) => ({
    toast: undefined,
    push(kind, message) {
        clearDismissTimer();
        const id = ++nextToastId;
        set({ toast: { id, kind, message } });
        /** Failures stay until they are replaced or dismissed; progress notifications self-expire. */
        if (kind !== 'error')
            dismissTimer = window.setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS);
    },
    dismiss(id) {
        const current = get().toast;
        if (!current || (id !== undefined && current.id !== id)) return;
        clearDismissTimer();
        set({ toast: undefined });
    },
}));

export function pushToast(kind: ToastKind, message: string): void {
    useToastStore.getState().push(kind, message);
}

export function dismissToast(): void {
    useToastStore.getState().dismiss();
}

/**
 * Renders any rejection as one sentence. `CaxriError` messages are already user-facing, so the code
 * is only consulted for the classifications whose message alone does not explain what to do next.
 */
export function describeFailure(error: unknown, label: string): string {
    if (isCaxriError(error)) {
        if (error.code === 'UNAVAILABLE') return `${label}: the Runtime is not available.`;
        if (error.code === 'TIMEOUT') return `${label}: the Runtime did not respond in time.`;
        return error.message;
    }
    return error instanceof Error ? error.message : label;
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
