import { useSyncExternalStore } from 'react';

import { notifyListeners } from '@caxri/utils';

import type { CopyFeedbackStatus } from '../components/copy-feedback';
import { COPY_FEEDBACK_RESET_MS, writeToClipboardWithFeedback } from '../components/copy-feedback';
import { textClipboard } from '../lib/clipboard';
import type { ToastAction, ToastActionId } from './toast-actions';

/**
 * Follow-ups that copy text and acknowledge it on their own button. A notification can stay on screen indefinitely, and
 * a second toast for "copied" would stack on the one it answers, so the button itself turns into `Copied` for a moment
 * (DESIGN.md "Copy feedback").
 */
const copyActionIds: ReadonlySet<ToastActionId> = new Set([
    'clipboard.copyCommand',
    'diagnostics.copyFailure',
]);

/**
 * Whether a follow-up reports its result in place, so surfaces can keep it on screen instead of dismissing it.
 */
export function isCopyToastAction(action: ToastAction): boolean {
    return copyActionIds.has(action.id);
}

/**
 * Identifies one button's feedback by what it copies, so the live toast and its notification-center entry show the same
 * state. The separator cannot appear in an action id.
 */
export function copyFeedbackKey(id: ToastActionId, text: string): string {
    return `${id}\u{0}${text}`;
}

/**
 * The key for a copy follow-up, or undefined for any other follow-up.
 */
export function copyFeedbackKeyOf(action: ToastAction): string | undefined {
    if (action.id === 'clipboard.copyCommand' || action.id === 'diagnostics.copyFailure')
        return copyFeedbackKey(action.id, action.params.text);
    return undefined;
}

const statuses = new Map<string, CopyFeedbackStatus>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<(value: undefined) => void>();

function publish(key: string, status: CopyFeedbackStatus): void {
    if (status === 'idle') statuses.delete(key);
    else statuses.set(key, status);
    notifyListeners(listeners, undefined);
}

/**
 * Copies `text`, shows `Copied` or `Copy failed` on the button for {@link COPY_FEEDBACK_RESET_MS}, then restores it. A
 * second click restarts the interval rather than letting the first timer cut the new acknowledgement short.
 */
export async function copyWithToastFeedback(
    key: string,
    text: string,
    clipboard: Pick<Clipboard, 'writeText'> = textClipboard,
): Promise<CopyFeedbackStatus> {
    const status = await writeToClipboardWithFeedback(clipboard, text);
    clearTimeout(timers.get(key));
    publish(key, status);
    timers.set(
        key,
        setTimeout(() => {
            timers.delete(key);
            publish(key, 'idle');
        }, COPY_FEEDBACK_RESET_MS),
    );
    return status;
}

export function getCopyFeedback(key: string): CopyFeedbackStatus {
    return statuses.get(key) ?? 'idle';
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useCopyFeedback(key: string): CopyFeedbackStatus {
    return useSyncExternalStore(subscribe, () => getCopyFeedback(key));
}
