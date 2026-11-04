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
 * How long a toast with an action stays while a screen reader is on: reaching a button by swipe navigation takes far
 * longer than a glance and a tap, and a toast that vanishes first makes Undo unreachable.
 */
export const TOAST_ACTION_SCREEN_READER_DURATION_MS = 20_000;

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

/**
 * The sentence a screen reader speaks for a toast: its message and detail, then that its action is available, so a
 * listener learns Undo exists without having to find the button.
 */
export const toastAnnouncement = (
    toast: Pick<ToastState, 'action' | 'detail' | 'message'>,
    actionAvailable: (label: string) => string,
): string =>
    [toast.message, toast.detail, toast.action ? actionAvailable(toast.action.label) : undefined]
        .filter(Boolean)
        .join('. ');

const toastDuration = (
    tone: ToastTone,
    action: ToastAction | undefined,
    isScreenReaderOn: boolean,
) => {
    if (action)
        return isScreenReaderOn ? TOAST_ACTION_SCREEN_READER_DURATION_MS : TOAST_ACTION_DURATION_MS;
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
    let isScreenReaderOn = false;
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
            handle = timers.set(dismiss, toastDuration(tone, action, isScreenReaderOn));
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
        /**
         * Tells the store whether a screen reader is on, which lengthens the toasts that carry an action.
         */
        setScreenReaderEnabled: (isEnabled: boolean) => {
            isScreenReaderOn = isEnabled;
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
