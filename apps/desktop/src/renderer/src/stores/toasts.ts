import type { ReactNode } from 'react';
import { createElement } from 'react';

import { errorMessage, isCaxriError } from '@caxri/protocol';
import type { ToastT } from 'sonner';
import { toast } from 'sonner';

import { caxri } from '../lib/caxri';
import type { NotificationType } from './notifications';
import {
    canMuteNotification,
    isNotificationMuted,
    notificationTypes,
    recordNotification,
    syncNotificationSettings,
} from './notifications';
import type { ToastAction } from './toast-actions';
import { runToastAction, toastActionLabels } from './toast-actions';

const activeReminderToasts = new Map<string | number, NotificationType>();
const openReminderMenus = new Set<string | number>();

interface ReminderOptionsProperties {
    onMute: () => void;
    onOpenChange: (isOpen: boolean) => void;
}

/**
 * Presentation is installed by the outlet so the notification store never imports feature components.
 */
const presentation = {
    render: undefined as
        ((properties: ReminderOptionsProperties) => ToastT['description']) | undefined,
};

export function configureReminderPresentation(
    render: (properties: ReminderOptionsProperties) => ToastT['description'],
): () => void {
    presentation.render = render;
    return () => {
        if (presentation.render === render) presentation.render = undefined;
    };
}

/**
 * `info` states a fact, `success` confirms what the user asked for happened, `warning` says the feature still works but
 * on reduced terms and needs no immediate answer, and `error` says the thing the user wanted did not happen. The split
 * between the last two is load-bearing: calling a degradation `error` is a lie while the feature still runs, and
 * calling it `info` hides that it is still in force (DESIGN.md "Toasts").
 */
export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
    /**
     * Stable, opt-in classification for reminders that may be muted.
     */
    type?: NotificationType;
    projectId?: string;
    projectTitle?: string;
    /**
     * Success feedback is ephemeral unless explicitly retained; other kinds are retained by default.
     */
    history?: boolean;
    /**
     * Keeps a notification on screen until the user dismisses it. Reserved for events that already cost the user
     * something irreversible — an external write replacing an unsaved buffer — where a 4-second auto-dismiss can
     * silently take the only record of it away.
     */
    persist?: boolean;
    /**
     * Optional immediate follow-up rendered as a keyboard-accessible button. Carried as an identity plus plain data
     * rather than a callback, so the notification center can still offer it after this toast has expired.
     */
    action?: ToastAction;
    /**
     * A second, lesser follow-up rendered before `action`, such as "View details" beside "Stop". Sonner removes the
     * notification after it runs, so it suits a follow-up that moves the user elsewhere; the history keeps both.
     */
    secondaryAction?: ToastAction;
}

/**
 * Sonner's label for a follow-up: the visible word, plus a screen-reader name when the word alone is ambiguous.
 */
function toastButtonLabel(action: ToastAction): ReactNode {
    if (!action.accessibleLabel) return toastActionLabels[action.id];
    return [
        createElement('span', { className: 'sr-only', key: 'accessible' }, action.accessibleLabel),
        createElement(
            'span',
            { 'aria-hidden': true, 'key': 'visible' },
            toastActionLabels[action.id],
        ),
    ];
}

/**
 * Runs a follow-up from a live toast. Even a four-second-old offer can already be stale — the Session it targets may
 * have been closed between the failure and the click — so the live button revalidates exactly like the history one.
 */
function runLiveToastAction(action: ToastAction): void {
    const reason = runToastAction(action);
    // Kept out of the history: the sentence only makes sense next to the click it answers, and on its own in the
    // notification center it would read as an event that happened by itself.
    if (reason) pushToast('error', reason, { history: false });
}

/**
 * Reads Sonner's active notifications without maintaining a second queue.
 */
export function getToasts(): ToastT[] {
    return toast.getToasts().filter((entry): entry is ToastT => !('dismiss' in entry));
}

/**
 * Retracts live notifications whose statement has stopped being true.
 *
 * A `persist` notice holds the screen until the user dismisses it, which is only honest while what it says still
 * describes reality. A notice that reports a condition the user can themselves undo — "restart to apply this setting",
 * where returning the setting to its launch value cancels the restart — would otherwise keep asserting a stale
 * instruction with no way for the surface that raised it to take it back. The history record deliberately stays: the
 * event did happen, and the center is a log rather than a live status.
 *
 * Matching on the message keeps callers free of Sonner ids, at the cost of requiring the caller to own a stable prefix.
 */
export function dismissToastsMatching(shouldDismiss: (message: string) => boolean): void {
    for (const entry of getToasts())
        if (typeof entry.title === 'string' && shouldDismiss(entry.title)) toast.dismiss(entry.id);
}

/**
 * Keeps command callers independent of rendering. Consecutive identical events update the live notification through
 * Sonner's id API; Sonner owns expiration, interaction pauses, and removal.
 */
export function pushToast(kind: ToastKind, message: string, options?: ToastOptions): void {
    const input = { kind, message, ...options };
    if (
        options?.history ??
        (kind !== 'success' || Boolean(options?.type) || Boolean(options?.persist))
    )
        recordNotification(input);
    if (isNotificationMuted(input)) return;
    const active = getToasts();
    const activeIds = new Set(active.map((entry) => entry.id));
    for (const key of activeReminderToasts.keys()) {
        if (activeIds.has(key)) {
            continue;
        }

        activeReminderToasts.delete(key);
        openReminderMenus.delete(key);
    }
    const newest = active.at(-1);
    const type = canMuteNotification(input) ? options?.type : undefined;
    const id =
        newest?.type === kind &&
        newest.title === message &&
        activeReminderToasts.get(newest.id) === type
            ? newest.id
            : undefined;
    const toastId = toast[kind](message, {
        id,
        duration:
            options?.persist || (id !== undefined && openReminderMenus.has(id)) ? Infinity : 4_000,
        description: type
            ? presentation.render?.({
                  onMute: () => {
                      // eslint-disable-next-line no-void -- muteNotification reports write failures through tryCommand
                      void muteNotification(type);
                  },
                  onOpenChange: (isOpen) => {
                      if (isOpen) openReminderMenus.add(toastId);
                      else openReminderMenus.delete(toastId);
                      // A portaled options menu is outside Sonner's hover boundary; hold its owner until the menu closes.
                      if (getToasts().some((entry) => entry.id === toastId))
                          toast[kind](message, {
                              id: toastId,
                              duration: isOpen ? Infinity : 4_000,
                          });
                  },
              })
            : undefined,
        action: options?.action && {
            label: toastButtonLabel(options.action),
            onClick: (event) => {
                // Sonner deletes the notification after an action unless the handler prevents it
                // (`sonner/dist/index.mjs`: `if (event.defaultPrevented) return;`). A `persist` notice is held until the
                // user dismisses it, so acting on it must not be the thing that takes it away: the GPU crash card's action
                // opens a confirmation the user can still cancel, and deleting the card first would leave Cancel with no
                // way back to the offer.
                if (options.persist) event.preventDefault();
                if (options.action) runLiveToastAction(options.action);
            },
        },
        cancel: options?.secondaryAction && {
            label: toastButtonLabel(options.secondaryAction),
            onClick: () => {
                if (options.secondaryAction) runLiveToastAction(options.secondaryAction);
            },
        },
    });
    if (type) activeReminderToasts.set(toastId, type);
    else activeReminderToasts.delete(toastId);
}

/**
 * Commit the single preference before hiding anything, so failed writes never pretend to have muted reminders.
 */
export async function muteNotification(type: NotificationType): Promise<void> {
    await tryCommand('Unable to mute notifications', async () => {
        const result = await caxri.request('settings.patch', {
            changes: [{ key: notificationTypes[type].key, value: false }],
        });
        syncNotificationSettings(result.value);
        for (const [id, entryType] of activeReminderToasts) {
            if (entryType !== type) continue;
            toast.dismiss(id);
            activeReminderToasts.delete(id);
            openReminderMenus.delete(id);
        }
    });
}

/**
 * Dismisses one notification, or all notifications when no id is supplied.
 */
export function dismissToast(id?: number | string): void {
    toast.dismiss(id);
}

const errnoReasons: Record<string, string> = {
    ENOENT: 'The file no longer exists.',
    ENOTDIR: 'The path is not a directory.',
    EISDIR: 'The path is a directory, not a file.',
    EACCES: 'Permission was denied.',
    EPERM: 'Permission was denied.',
    ENOSPC: 'The disk is full.',
    EEXIST: 'A file with that name already exists.',
    EPIPE: 'The connection was interrupted.',
    ECONNREFUSED: 'The service refused the connection.',
};

/**
 * Keeps a rejected filesystem path out of fallback copy while retaining the rest of an unknown reason.
 */
function redactAbsolutePaths(message: string): string {
    return message
        .replaceAll(/(['"])(?:file:\/\/\/|\/|[A-Za-z]:[\\/])[^'"]+\1/gu, 'a file')
        .replaceAll(/file:\/\/\/[^\s'",;)\]]+/gu, 'a file')
        .replaceAll(/(?<![A-Za-z0-9:/])\/[^\s'",;)\]]+/gu, 'a file')
        .replaceAll(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'",;)\]]+/gu, 'a file');
}

/**
 * Preserves the caller's operation label and turns low-level failures into a path-free reason.
 */
export function describeFailure(error: unknown, label: string): string {
    const rawMessage = errorMessage(error, '');
    const errorCode = (error as { code?: unknown } | null)?.code;
    const errno =
        typeof errorCode === 'string' && errnoReasons[errorCode]
            ? errorCode
            : /\b(?:ENOENT|ENOTDIR|EISDIR|EACCES|EPERM|ENOSPC|EEXIST|EPIPE|ECONNREFUSED)\b/u.exec(
                  rawMessage,
              )?.[0];
    const fallback = isCaxriError(error)
        ? error.code === 'UNAVAILABLE'
            ? 'Caxri is not ready yet.'
            : error.code === 'TIMEOUT'
              ? 'Caxri did not respond in time.'
              : 'The operation could not be completed.'
        : 'The operation could not be completed.';
    const reason = errno
        ? errnoReasons[errno]
        : redactAbsolutePaths(rawMessage)
              .replaceAll(
                  /\b(?:VALIDATION|NOT_FOUND|PATH_DENIED|CAPACITY|UNAVAILABLE|TIMEOUT|CANCELLED|CONFLICT|FORBIDDEN|IO|GIT|INTERNAL)\b:?\s*/gu,
                  '',
              )
              .replaceAll(/\bE[A-Z0-9]{2,}\b:?\s*/gu, '')
              .replaceAll(/\s+/gu, ' ')
              .trim() || fallback;
    const sentence = /[.!?]$/u.test(reason) ? reason : `${reason}.`;
    return `${redactAbsolutePaths(label).replaceAll(/[.:!?\s]+$/gu, '')}. ${sentence}`;
}

/**
 * A cancelled request is an expected outcome rather than a failure the user can act on, and often arrives when there is
 * no longer anywhere to show it: Main refuses queued Renderer work as soon as quit starts, and the Host client cancels
 * everything in flight when a lease is replaced or a connection is disposed. `shouldToastQueryError` applies the same
 * rule to reads; this keeps writes consistent with it. Exported so the Session-state write path — which reports its own
 * failures instead of going through `tryCommand` — applies the identical rule.
 */
export function isCancelledRequest(error: unknown): boolean {
    return isCaxriError(error) && error.code === 'CANCELLED';
}

export interface TryCommandOptions {
    /**
     * Re-reads the Server snapshot after the operation succeeds.
     */
    refresh?: () => Promise<void>;
    /**
     * Builds a recovery button that retains this failure's operation context.
     */
    recovery?: (error: unknown) => ToastAction;
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
        if (!isCancelledRequest(error)) {
            const recovery = options.recovery?.(error);
            pushToast('error', describeFailure(error, label), {
                action: recovery && {
                    ...recovery,
                    accessibleLabel: `${toastActionLabels[recovery.id]} ${redactAbsolutePaths(label)}`,
                },
            });
        }
        return undefined;
    }
}
