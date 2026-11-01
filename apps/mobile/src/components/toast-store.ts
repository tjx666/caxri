import { notifyListeners } from '../lib/notify-listeners';

/**
 * How long one toast stays on screen before it removes itself.
 */
export const TOAST_DURATION_MS = 3000;

/**
 * How long an error toast stays: longer than a success, since it carries a reason the reader may need to read.
 */
export const TOAST_ERROR_DURATION_MS = 6000;

/**
 * How long a toast with an action stays: long enough to notice the button, reach it, and press it.
 */
export const TOAST_ACTION_DURATION_MS = 8000;

/**
 * One button on a toast, such as Undo after an archive. Pressing it also removes the toast.
 */
export interface ToastAction {
    label: string;
    onPress: () => void;
}

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
    action?: ToastAction;
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

const toastDuration = (tone: ToastTone, action: ToastAction | undefined) => {
    if (action) return TOAST_ACTION_DURATION_MS;
    return tone === 'error' ? TOAST_ERROR_DURATION_MS : TOAST_DURATION_MS;
};

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
        show: (tone: ToastTone, message: string, detail?: string, action?: ToastAction) => {
            if (handle !== undefined) timers.clear(handle);
            current = { action, detail, id: nextId, message, tone };
            nextId += 1;
            handle = timers.set(dismiss, toastDuration(tone, action));
            emit();
        },
        /**
         * Runs the action of the toast on screen and removes it; a stale press for a toast already replaced does
         * nothing.
         */
        runAction: (id: number) => {
            const action = current?.id === id ? current.action : undefined;
            if (!action) return;
            dismiss();
            action.onPress();
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
 * Shows a toast, replacing any toast already on screen. `ToastHost` renders in the root window, so on Android a toast
 * fired while a `BottomSheet` stays open sits under the sheet's `Modal` window and is never seen: dismiss the sheet
 * first, or confirm inside it (the work detail sheet's Copy swaps its icon to a check).
 */
export const showToast = toastStore.show;
