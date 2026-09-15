import { beforeEach, describe, expect, it } from 'vitest';

import {
    canMuteNotification,
    isNotificationMuted,
    recordNotification,
    syncNotificationSettings,
    useNotificationStore,
} from './notifications';

const enabled = { 'notifications.worktreeFallback': true, 'notifications.agentRecovery': true };
const reminder = {
    kind: 'info',
    message: 'Returned to Project',
    type: 'worktree-fallback',
    projectId: 'project-1',
} as const;

describe('notification history', () => {
    beforeEach(() => {
        useNotificationStore.setState({ entries: [], isOpen: false, mutedTypes: [], sequence: 0 });
    });

    it('keeps muted events in history without unread state, and restores future reminders', () => {
        recordNotification(reminder);
        syncNotificationSettings({ ...enabled, 'notifications.worktreeFallback': false });
        expect(isNotificationMuted(reminder)).toBe(true);
        expect(useNotificationStore.getState().entries[0].unread).toBe(false);
        recordNotification(reminder);
        expect(useNotificationStore.getState().entries).toMatchObject([
            { count: 2, unread: false },
        ]);
        syncNotificationSettings(enabled);
        expect(isNotificationMuted(reminder)).toBe(false);
        recordNotification(reminder);
        expect(useNotificationStore.getState().entries).toMatchObject([{ count: 3, unread: true }]);
    });

    it('never mutes failures or data-loss notices even when they carry a muted type', () => {
        syncNotificationSettings({ ...enabled, 'notifications.worktreeFallback': false });
        for (const input of [
            { ...reminder, kind: 'error' as const },
            { ...reminder, persist: true },
        ]) {
            expect(canMuteNotification(input)).toBe(false);
            expect(isNotificationMuted(input)).toBe(false);
            recordNotification(input);
        }
        syncNotificationSettings({ ...enabled, 'notifications.worktreeFallback': false });
        expect(useNotificationStore.getState().entries.every((entry) => entry.unread)).toBe(true);
    });

    it('groups repeats within the same Project and retains only the latest 100 entries', () => {
        recordNotification(reminder);
        recordNotification({ ...reminder, projectId: 'project-2' });
        recordNotification(reminder);
        expect(useNotificationStore.getState().entries.map((entry) => entry.count)).toEqual([2, 1]);
        for (let index = 0; index < 101; index++)
            recordNotification({ kind: 'error', message: `Failure ${index}` });
        expect(useNotificationStore.getState().entries).toHaveLength(100);
        expect(useNotificationStore.getState().entries.at(-1)?.message).toBe('Failure 1');
    });

    it('marks existing and incoming entries read while open; removal is separate from muting', () => {
        recordNotification(reminder);
        useNotificationStore.getState().setOpen(true);
        recordNotification({ kind: 'error', message: 'Failure' });
        expect(useNotificationStore.getState().entries.every((entry) => !entry.unread)).toBe(true);
        useNotificationStore.getState().remove(useNotificationStore.getState().entries[0].id);
        expect(useNotificationStore.getState().entries).toHaveLength(1);
        useNotificationStore.getState().clear();
        expect(useNotificationStore.getState().entries).toEqual([]);
        expect(isNotificationMuted(reminder)).toBe(false);
    });

    /**
     * The retained follow-up is why the history can still offer `Undo` after the toast expired, and why it may only
     * ever be a name plus plain data: a closure could not survive the entry, and a body could not safely be stored in
     * it.
     */
    it('retains a follow-up as plain data and caps unbounded message bodies', () => {
        const input = {
            ...reminder,
            message: 'x'.repeat(5_000),
            action: { id: 'session.unarchive', params: { sessionId: 'session-1' } },
        } as const;
        recordNotification(input);
        const entry = useNotificationStore.getState().entries[0];
        expect(entry.message).toHaveLength(4_096);
        expect(entry.action).toEqual({
            id: 'session.unarchive',
            params: { sessionId: 'session-1' },
        });
        // Cloning is the assertion: a closure hiding in the entry would make this throw, not merely differ.
        expect(structuredClone(entry.action)).toEqual(entry.action);
    });

    it('preserves store and history identities when unrelated bootstrap settings refresh', () => {
        recordNotification(reminder);
        const before = useNotificationStore.getState();
        syncNotificationSettings(enabled);
        expect(useNotificationStore.getState()).toBe(before);
    });
});
