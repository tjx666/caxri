import type { AppSettings } from '@caxri/protocol';

import type { TranslationKey } from '../i18n';
import { createStore } from '../lib/store';
import type { ToastAction } from './toast-actions';

/**
 * Stable event identities keep preferences independent of message text and Project names.
 */
export const notificationTypes = {
    'worktree-fallback': {
        key: 'notifications.worktreeFallback',
        titleKey: 'toasts.type.worktreeFallback',
    },
    'agent-recovery': { key: 'notifications.agentRecovery', titleKey: 'toasts.type.agentRecovery' },
} as const satisfies Record<string, { key: string; titleKey: TranslationKey }>;

export type NotificationType = keyof typeof notificationTypes;
type NotificationKind = 'info' | 'success' | 'warning' | 'error';

export interface NotificationInput {
    kind: NotificationKind;
    message: string;
    type?: NotificationType;
    projectId?: string;
    projectTitle?: string;
    /**
     * Persistent data-loss notices and failures must never be suppressible.
     */
    persist?: boolean;
    /**
     * The follow-up this notification offered. Retained because it is an identity plus plain data rather than a
     * closure: the history can rebuild the button from it, which is the whole point of storing it here.
     */
    action?: ToastAction;
    /**
     * The lesser follow-up shown beside `action`, retained for the same reason.
     */
    secondaryAction?: ToastAction;
}

export interface NotificationEntry extends NotificationInput {
    id: number;
    count: number;
    timestamp: number;
    unread: boolean;
}

interface NotificationState {
    entries: NotificationEntry[];
    isOpen: boolean;
    mutedTypes: NotificationType[];
    sequence: number;
    setOpen: (isOpen: boolean) => void;
    clear: () => void;
    remove: (id: number) => void;
}

/**
 * History is intentionally memory-only: never persist arbitrary notification bodies, and never store anything but the
 * name of a follow-up plus the plain data it needs.
 */
export const useNotificationStore = createStore<NotificationState>('notifications', (set) => ({
    entries: [],
    isOpen: false,
    mutedTypes: [],
    sequence: 0,
    setOpen: (isOpen) =>
        set((state) => ({
            isOpen,
            entries: isOpen
                ? state.entries.map((entry) => ({ ...entry, unread: false }))
                : state.entries,
        })),
    clear: () => set({ entries: [] }),
    remove: (id) => set((state) => ({ entries: state.entries.filter((entry) => entry.id !== id) })),
}));

export function syncNotificationSettings(
    settings: Pick<AppSettings, 'notifications.worktreeFallback' | 'notifications.agentRecovery'>,
): void {
    const mutedTypes = (Object.keys(notificationTypes) as NotificationType[]).filter(
        (type) => settings[notificationTypes[type].key] === false,
    );
    const previous = useNotificationStore.getState().mutedTypes;
    if (
        previous.length === mutedTypes.length &&
        previous.every((type, index) => type === mutedTypes[index])
    )
        return;
    const mutedTypeSet = new Set(mutedTypes);
    useNotificationStore.setState((state) => ({
        mutedTypes,
        entries: state.entries.map((entry) =>
            canMuteNotification(entry) && entry.type && mutedTypeSet.has(entry.type)
                ? { ...entry, unread: false }
                : entry,
        ),
    }));
}

export function canMuteNotification(input: NotificationInput): boolean {
    return Boolean(input.type) && input.kind !== 'error' && !input.persist;
}

export function isNotificationMuted(input: NotificationInput): boolean {
    return (
        canMuteNotification(input) &&
        Boolean(input.type && useNotificationStore.getState().mutedTypes.includes(input.type))
    );
}

/**
 * Whether Zen Mode keeps this notification off the screen. Zen is for attention, so only what asks the user for
 * something stays: a failure (`error`), a notice held until dismissed (`persist`, data loss and one-time disclosures),
 * and anything offering a follow-up button (a recovery, an update ready to install). The remaining `info`, `success`,
 * and `warning` notices report a fact or a degradation that needs no answer; they still enter the history, which the
 * status bar bell shows again when Zen ends. Approval and question requests are Chat cards, not toasts, so this filter
 * never touches them.
 */
export function isSilencedInZenMode(input: NotificationInput): boolean {
    return input.kind !== 'error' && !input.persist && !input.action && !input.secondaryAction;
}

/**
 * Group exact repeats within a Project, cap both entry count and retained body size.
 */
export function recordNotification(input: NotificationInput): void {
    const state = useNotificationStore.getState();
    const message = input.message.slice(0, 4_096);
    const previous = state.entries.find(
        (entry) =>
            entry.kind === input.kind &&
            entry.message === message &&
            entry.type === input.type &&
            entry.projectId === input.projectId &&
            Boolean(entry.persist) === Boolean(input.persist),
    );
    const timestamp = Date.now();
    const entry: NotificationEntry = {
        kind: input.kind,
        type: input.type,
        // The newest occurrence owns the button: grouped repeats share one row, and an offer that targets a Session the
        // earlier failure no longer describes would be revalidated into a dead end.
        action: input.action,
        secondaryAction: input.secondaryAction,
        projectId: input.projectId,
        persist: input.persist,
        message,
        projectTitle: input.projectTitle?.slice(0, 256),
        id: previous?.id ?? state.sequence + 1,
        timestamp,
        count: Math.min((previous?.count ?? 0) + 1, 999),
        unread: !state.isOpen && !isNotificationMuted(input),
    };
    useNotificationStore.setState({
        sequence: state.sequence + 1,
        entries: [entry, ...state.entries.filter((item) => item.id !== entry.id)].slice(0, 100),
    });
}
