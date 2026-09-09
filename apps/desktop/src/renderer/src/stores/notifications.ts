import type { AppSettings } from '@caxri/protocol';
import { create } from 'zustand';

/**
 * Stable event identities keep preferences independent of message text and Project names.
 */
export const notificationTypes = {
    'worktree-fallback': { key: 'notifications.worktreeFallback', title: 'Worktree fallback' },
    'agent-recovery': { key: 'notifications.agentRecovery', title: 'Automatic Agent recovery' },
} as const;

export type NotificationType = keyof typeof notificationTypes;
type NotificationKind = 'info' | 'success' | 'error';

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
}

export interface NotificationEntry extends NotificationInput {
    id: number;
    count: number;
    timestamp: number;
    timeLabel: string;
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
 * History is intentionally memory-only: never persist arbitrary notification bodies or action closures.
 */
export const useNotificationStore = create<NotificationState>((set) => ({
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
    useNotificationStore.setState((state) => ({
        mutedTypes,
        entries: state.entries.map((entry) =>
            canMuteNotification(entry) && entry.type && mutedTypes.includes(entry.type)
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
        projectId: input.projectId,
        persist: input.persist,
        message,
        projectTitle: input.projectTitle?.slice(0, 256),
        id: previous?.id ?? state.sequence + 1,
        timestamp,
        timeLabel: new Date(timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        }),
        count: Math.min((previous?.count ?? 0) + 1, 999),
        unread: !state.isOpen && !isNotificationMuted(input),
    };
    useNotificationStore.setState({
        sequence: state.sequence + 1,
        entries: [entry, ...state.entries.filter((item) => item.id !== entry.id)].slice(0, 100),
    });
}
