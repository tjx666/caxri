import { notifyListeners } from '../lib/notify-listeners';

/**
 * How long one toast stays on screen before it removes itself.
 */
export const TOAST_DURATION_MS = 3000;

/**
 * `success` confirms an action that finished (a copy); `error` reports one that could not (a preview or link that would
 * not open). The tone only picks the icon and its color; the sentence always says what happened.
 */
export type ToastTone = 'error' | 'success';

/**
 * The toast on screen. `id` changes with every `show`, so a replacement restarts the entrance and the screen-reader
 * announcement even when the text is identical.
 */
export interface ToastState {
    /**
     * An optional second line, such as the reason a preview did not open.
     */
    detail?: string;
    id: number;
    message: string;
    tone: ToastTone;
}

export interface ToastTimers {
    clear: (handle: unknown) => void;
    set: (callback: () => void, delayMs: number) => unknown;
}

const systemTimers: ToastTimers = {
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    set: (callback, delayMs) => setTimeout(callback, delayMs),
};

/**
 * The single transient-message queue of the app: at most one toast at a time, and a new one replaces the current one
 * and restarts the timer. It is a plain store (not React state) so non-component code such as `openExternalLink` can
 * report a result without a hook; `ToastHost` renders its snapshot. `timers` exists so the timing is testable.
 */
export const createToastStore = (timers: ToastTimers = systemTimers) => {
    let current: ToastState | undefined;
    let nextId = 1;
    let handle: unknown;
    const listeners = new Set<() => void>();
    const emit = () => {
        notifyListeners(listeners, undefined);
    };
    const dismiss = () => {
        if (handle !== undefined) timers.clear(handle);
        handle = undefined;
        if (current === undefined) return;
        current = undefined;
        emit();
    };
    return {
        dismiss,
        getSnapshot: (): ToastState | undefined => current,
        show: (tone: ToastTone, message: string, detail?: string) => {
            if (handle !== undefined) timers.clear(handle);
            current = { detail, id: nextId, message, tone };
            nextId += 1;
            handle = timers.set(dismiss, TOAST_DURATION_MS);
            emit();
        },
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
};

/**
 * The app-wide store behind `showToast` and `ToastHost`.
 */
export const toastStore = createToastStore();

/**
 * Shows a toast, replacing any toast already on screen.
 */
export const showToast = toastStore.show;
