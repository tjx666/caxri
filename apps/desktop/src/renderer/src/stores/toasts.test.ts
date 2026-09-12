import { CaxriError } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    refreshWorkbench: vi.fn(() => Promise.resolve()),
    request: vi.fn(),
}));

vi.mock('../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { syncNotificationSettings, useNotificationStore } from './notifications';
import {
    describeFailure,
    dismissToast,
    getToasts,
    muteNotification,
    pushToast,
    tryCommand,
} from './toasts';

describe('Sonner notification adapter', () => {
    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
            setTimeout(callback, 0),
        );
        vi.stubGlobal('cancelAnimationFrame', clearTimeout);
        mocks.refreshWorkbench.mockClear();
        mocks.request.mockReset();
        dismissToast();
        useNotificationStore.setState({ entries: [], isOpen: false, mutedTypes: [], sequence: 0 });
    });

    afterEach(() => {
        dismissToast();
        vi.unstubAllGlobals();
    });

    it('pushes a notification and reports it in arrival order', () => {
        pushToast('info', 'first');
        pushToast('info', 'second');

        expect(getToasts().map((toast) => toast.title)).toEqual(['first', 'second']);
    });

    it('retains muted reminders without creating a popup and keeps errors visible', () => {
        syncNotificationSettings({
            'notifications.worktreeFallback': false,
            'notifications.agentRecovery': true,
        });
        pushToast('info', 'Returned to Project', { type: 'worktree-fallback' });
        expect(getToasts()).toEqual([]);
        expect(useNotificationStore.getState().entries).toMatchObject([{ unread: false }]);
        pushToast('error', 'Failed to return', { type: 'worktree-fallback' });
        expect(getToasts()).toHaveLength(1);
    });

    it('keeps copy success out of history and retains explicitly persistent success', () => {
        pushToast('success', 'Path copied');
        expect(useNotificationStore.getState().entries).toEqual([]);
        pushToast('success', 'Recovered', { persist: true });
        expect(useNotificationStore.getState().entries).toHaveLength(1);
    });

    it('keeps reminders visible when persistence fails and dismisses them only after a successful mute', async () => {
        pushToast('info', 'Returned to Project', { type: 'worktree-fallback' });
        mocks.request.mockRejectedValueOnce(new Error('Could not save settings'));
        await muteNotification('worktree-fallback');
        expect(getToasts().map((entry) => entry.title)).toContain('Returned to Project');
        expect(useNotificationStore.getState().mutedTypes).toEqual([]);
        mocks.request.mockResolvedValueOnce({
            value: { 'notifications.worktreeFallback': false, 'notifications.agentRecovery': true },
        });
        await muteNotification('worktree-fallback');
        expect(getToasts().map((entry) => entry.title)).not.toContain('Returned to Project');
        expect(getToasts().map((entry) => entry.title)).toContain('Could not save settings');
        expect(useNotificationStore.getState().mutedTypes).toEqual(['worktree-fallback']);
    });

    it('dismisses a single toast by id and leaves the others', () => {
        pushToast('info', 'first');
        pushToast('info', 'second');
        const [firstId] = getToasts().map((toast) => toast.id);

        dismissToast(firstId);

        expect(getToasts().map((toast) => toast.title)).toEqual(['second']);
    });

    it('dismisses every toast when no id is given', () => {
        pushToast('info', 'first');
        pushToast('info', 'second');

        dismissToast();

        expect(getToasts()).toEqual([]);
    });

    it.each(['info', 'success', 'error'] as const)(
        'gives Sonner a four-second lifetime for %s notifications',
        (kind) => {
            pushToast(kind, 'auto-dismiss me');

            expect(getToasts()).toEqual([expect.objectContaining({ type: kind, duration: 4_000 })]);
        },
    );

    it('never auto-dismisses an error toast opted into persist', () => {
        pushToast('error', 'stays until dismissed', { persist: true });

        expect(getToasts()[0].duration).toBe(Infinity);
    });

    it('never auto-dismisses an info toast opted into persist', () => {
        pushToast('info', 'stays until dismissed', { persist: true });

        expect(getToasts()[0].duration).toBe(Infinity);
    });

    it('keeps an optional follow-up action on the notification', () => {
        const onSelect = vi.fn();
        pushToast('success', 'recovered', {
            action: { label: 'Open Settings', onSelect },
        });

        expect(getToasts()[0].action).toEqual({
            label: 'Open Settings',
            onClick: onSelect,
        });
    });

    it.each(['info', 'success', 'error'] as const)(
        'updates a repeated %s toast without stacking it',
        (kind) => {
            pushToast(kind, 'duplicate message');
            const [firstId] = getToasts().map((toast) => toast.id);
            pushToast(kind, 'duplicate message');

            expect(getToasts()).toHaveLength(1);
            expect(getToasts()[0].id).toBe(firstId);
        },
    );

    it('does not re-arm when the newest toast differs in kind or message', () => {
        pushToast('info', 'same text');
        pushToast('error', 'same text');

        expect(getToasts()).toHaveLength(2);
    });

    it('updates persistence and clears an obsolete action on a repeated notification', () => {
        pushToast('info', 'notice', {
            persist: true,
            action: { label: 'Review', onSelect: vi.fn() },
        });
        pushToast('info', 'notice');
        expect(getToasts()).toHaveLength(1);
        expect(getToasts()[0]).toMatchObject({ duration: 4_000, action: undefined });
    });

    it('creates a fresh notification after the previous one was dismissed', () => {
        pushToast('info', 'notice');
        const previousId = getToasts()[0].id;
        dismissToast();
        pushToast('info', 'notice');
        expect(getToasts()).toHaveLength(1);
        expect(getToasts()[0].id).not.toBe(previousId);
    });

    it('keeps the Server reason for UNAVAILABLE and TIMEOUT, labelled by the failed action', () => {
        expect(
            describeFailure(
                new CaxriError('UNAVAILABLE', 'Codex could not rename the Agent session'),
                'Session rename failed',
            ),
        ).toBe('Session rename failed: Codex could not rename the Agent session');
        expect(
            describeFailure(new CaxriError('TIMEOUT', 'Codex Session rename timed out'), 'Rename'),
        ).toBe('Rename: Codex Session rename timed out');
    });

    it('falls back to generic copy only when the classified error carries no message', () => {
        expect(describeFailure(new CaxriError('UNAVAILABLE', ''), 'Save file')).toBe(
            'Save file: Caxri is not ready yet.',
        );
        expect(describeFailure(new CaxriError('TIMEOUT', ''), 'Save file')).toBe(
            'Save file: Caxri did not respond in time.',
        );
    });

    it('falls back to the CaxriError message for any other code', () => {
        expect(describeFailure(new CaxriError('NOT_FOUND', 'File is gone'), 'Save file')).toBe(
            'File is gone',
        );
    });

    it('falls back to the label for a non-Error rejection', () => {
        expect(describeFailure('not an Error instance', 'Save file')).toBe('Save file');
    });

    it('uses the plain Error message for a non-CaxriError rejection', () => {
        expect(describeFailure(new Error('disk is full'), 'Save file')).toBe('disk is full');
    });

    it('tryCommand resolves with the run() result on success without refreshing', async () => {
        const run = vi.fn(() => Promise.resolve('ok'));

        const result = await tryCommand('Save file', run);

        expect(result).toBe('ok');
        expect(mocks.refreshWorkbench).not.toHaveBeenCalled();
        expect(getToasts()).toEqual([]);
    });

    it('tryCommand refreshes the workbench after a successful run when requested', async () => {
        const run = vi.fn(() => Promise.resolve('ok'));

        await tryCommand('Save file', run, { refresh: mocks.refreshWorkbench });

        expect(mocks.refreshWorkbench).toHaveBeenCalledOnce();
    });

    it('tryCommand funnels a rejection into exactly one error toast and resolves undefined', async () => {
        const run = vi.fn(() => Promise.reject(new CaxriError('IO', 'disk is full')));

        const result = await tryCommand('Save file', run);

        expect(result).toBeUndefined();
        expect(mocks.refreshWorkbench).not.toHaveBeenCalled();
        const toasts = getToasts();
        expect(toasts).toHaveLength(1);
        expect(toasts[0]).toMatchObject({ type: 'error', title: 'disk is full', duration: 4_000 });
    });

    /**
     * Main answers every queued Renderer request with this once quit starts, so a read still in flight when the user
     * quits would otherwise raise a notification over a window that is already going away.
     */
    it('tryCommand stays silent when the request was cancelled', async () => {
        const run = vi.fn(() =>
            Promise.reject(new CaxriError('CANCELLED', 'Application is quitting')),
        );

        const result = await tryCommand('Unable to read directory', run);

        expect(result).toBeUndefined();
        expect(getToasts()).toEqual([]);
    });

    it('tryCommand does not refresh the workbench when the run rejects', async () => {
        const run = vi.fn(() => Promise.reject(new Error('boom')));

        await tryCommand('Save file', run, { refresh: mocks.refreshWorkbench });

        expect(mocks.refreshWorkbench).not.toHaveBeenCalled();
    });
});
