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

export type ToastKind = 'info' | 'success' | 'error';

interface ToastAction {
    label: string;
    onSelect: () => void;
}

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
        action: options?.action
            ? { label: options.action.label, onClick: options.action.onSelect }
            : undefined,
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
