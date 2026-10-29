import { CaxriError } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    refreshWorkbench: vi.fn(() => Promise.resolve()),
    request: vi.fn(),
}));

vi.mock('../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { applyLanguagePreference, translate } from '../i18n';
import { syncNotificationSettings, useNotificationStore } from './notifications';
import type { ToastActionHandler, ToastActionHandlers, ToastActionId } from './toast-actions';
import { configureToastActions, toastActionLabelKeys } from './toast-actions';
import {
    describeFailure,
    describeFailureNotice,
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
        expect(getToasts().map((entry) => entry.title)).toContain(
            'Unable to mute notifications. Could not save settings.',
        );
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

    /**
     * Installs a complete handler table with inert defaults, so a test only has to state the one follow-up it is about.
     */
    function installToastActions(
        overrides: Partial<{ [Id in ToastActionId]: ToastActionHandler<Id> }> = {},
    ): void {
        const handlers = {} as ToastActionHandlers;
        for (const id of Object.keys(toastActionLabelKeys))
            Object.assign(handlers, { [id]: { run: () => {} } });
        configureToastActions(Object.assign(handlers, overrides));
    }

    /**
     * Sonner hands the action handler the real click and decides whether the notification survives from
     * `event.defaultPrevented`. It types that handler as a React mouse event, but the handler only uses the DOM
     * contract the synthetic event forwards, so Node's global `Event` exercises it faithfully without a DOM.
     */
    function clickToastAction(): Event {
        const event = new Event('click', { cancelable: true });
        const action = getToasts()[0].action;
        if (typeof action !== 'object' || action === null || !('onClick' in action))
            throw new TypeError('This notification carries no action.');
        (action.onClick as unknown as (clicked: Event) => void)(event);
        return event;
    }

    function toastActionLabel(): unknown {
        const action = getToasts()[0].action;
        return typeof action === 'object' && action !== null && 'label' in action
            ? action.label
            : undefined;
    }

    it('keeps an optional follow-up action on the notification', () => {
        const onSelect = vi.fn();
        installToastActions({ 'settings.open': { run: onSelect } });
        pushToast('success', 'recovered', { action: { id: 'settings.open' } });

        expect(toastActionLabel()).toBe('Open Settings');
        const event = clickToastAction();
        expect(onSelect).toHaveBeenCalledOnce();
        // An ephemeral notice has said what it had to say; acting on it is a fine moment for it to go.
        expect(event.defaultPrevented).toBe(false);
    });

    /**
     * A follow-up that can no longer run says so where the click happened, instead of the button doing nothing at all.
     */
    it('reports why a live follow-up can no longer run', () => {
        const run = vi.fn();
        installToastActions({
            'session.unarchive': { run, unavailable: () => 'That Session no longer exists.' },
        });
        pushToast('info', 'archived', {
            action: { id: 'session.unarchive', params: { sessionId: 'session-1' } },
        });
        clickToastAction();

        expect(run).not.toHaveBeenCalled();
        expect(getToasts().map((entry) => entry.title)).toContain('That Session no longer exists.');
    });

    /**
     * Sonner deletes a notification after its action unless the handler calls `preventDefault`. A `persist` card is
     * held until the user dismisses it, and its action routinely opens a confirmation the user can still cancel, so
     * deleting the card on click would take the only way back to the offer.
     */
    it('survives its own action when the notification is persistent', () => {
        const onSelect = vi.fn();
        installToastActions({ 'settings.turnOffHardwareAcceleration': { run: onSelect } });
        pushToast('warning', 'drawing failed', {
            persist: true,
            action: { id: 'settings.turnOffHardwareAcceleration' },
        });

        expect(onSelect).not.toHaveBeenCalled();
        expect(clickToastAction().defaultPrevented).toBe(true);
        expect(onSelect).toHaveBeenCalledOnce();
    });

    it('takes a persistent notice away once an action that resolves it succeeds, and keeps it when refused', () => {
        const restore = vi.fn();
        let refusal: string | undefined = 'The file was closed.';
        installToastActions({
            'editor.restoreDiscardedChanges': { run: restore, unavailable: () => refusal },
        });
        const options = {
            persist: true,
            dismissOnSuccess: true,
            action: {
                id: 'editor.restoreDiscardedChanges' as const,
                params: { sessionId: 's', workbenchRootProjectId: 'p', paths: ['README.md'] },
            },
        };
        pushToast('warning', 'changes replaced', options);

        clickToastAction();
        expect(restore).not.toHaveBeenCalled();
        expect(getToasts().map((entry) => entry.title)).toContain('changes replaced');

        refusal = undefined;
        clickToastAction();
        expect(restore).toHaveBeenCalledOnce();
        expect(getToasts().map((entry) => entry.title)).not.toContain('changes replaced');
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
        installToastActions();
        pushToast('info', 'notice', { persist: true, action: { id: 'settings.open' } });
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
                translate,
            ),
        ).toBe('Session rename failed. Codex could not rename the Agent session.');
        expect(
            describeFailure(
                new CaxriError('TIMEOUT', 'Codex Session rename timed out'),
                'Rename',
                translate,
            ),
        ).toBe('Rename. Codex Session rename timed out.');
    });

    it('falls back to generic copy only when the classified error carries no message', () => {
        expect(describeFailure(new CaxriError('UNAVAILABLE', ''), 'Save file', translate)).toBe(
            'Save file. Caxri is not ready yet.',
        );
        expect(describeFailure(new CaxriError('TIMEOUT', ''), 'Save file', translate)).toBe(
            'Save file. Caxri did not respond in time.',
        );
    });

    it('keeps the operation label for other CaxriError codes', () => {
        expect(
            describeFailure(new CaxriError('NOT_FOUND', 'File is gone'), 'Save file', translate),
        ).toBe('Save file. File is gone.');
    });

    it('falls back to the label for a non-Error rejection', () => {
        expect(describeFailure('not an Error instance', 'Save file', translate)).toBe(
            'Save file. The operation could not be completed.',
        );
    });

    it('uses the plain Error message for a non-CaxriError rejection', () => {
        expect(describeFailure(new Error('disk is full'), 'Save file', translate)).toBe(
            'Save file. disk is full.',
        );
    });

    it.each([
        ['ENOENT', 'The file no longer exists.'],
        ['EACCES', 'Permission was denied.'],
        ['EPERM', 'Permission was denied.'],
        ['ENOSPC', 'The disk is full.'],
        ['EEXIST', 'A file with that name already exists.'],
    ])('turns %s into a human-readable reason', (code, reason) => {
        const error = Object.assign(new Error(`${code}: open '/Users/me/project/note.txt'`), {
            code,
        });
        expect(describeFailure(error, 'Save failed', translate)).toBe(`Save failed. ${reason}`);
    });

    it('redacts Unix, Windows, and file URL paths from unknown reasons', () => {
        expect(
            describeFailure(
                new CaxriError(
                    'IO',
                    String.raw`Could not open '/Users/me/private/note.txt' or C:\Users\me\private\note.txt`,
                ),
                'Save failed',
                translate,
            ),
        ).toBe('Save failed. Could not open a file or a file.');
        expect(
            describeFailure(
                new Error('Failed at file:///Users/me/private/note.txt'),
                'Save failed',
                translate,
            ),
        ).toBe('Save failed. Failed at a file.');
        expect(
            describeFailure(
                new Error('Access denied'),
                'Open /Users/me/private/note.txt failed',
                translate,
            ),
        ).toBe('Open a file failed. Access denied.');
    });

    it('keeps a slash command name in a failure label', () => {
        expect(
            describeFailure(
                new Error("unknown revision 'abc'"),
                '/review could not run',
                translate,
            ),
        ).toBe("/review could not run. unknown revision 'abc'.");
    });

    it('does not show a protocol error enum in the toast', () => {
        expect(
            describeFailure(new CaxriError('IO', 'IO: write failed'), 'Save failed', translate),
        ).toBe('Save failed. write failed.');
    });

    describe('in a locale the Server does not write', () => {
        beforeEach(() => {
            applyLanguagePreference('zh-CN');
        });
        afterEach(() => {
            applyLanguagePreference(null);
        });

        it.each([
            ['CONFLICT', '与较新的更改冲突，请刷新后重试。'],
            ['NOT_FOUND', '目标已不存在。'],
            ['PATH_DENIED', '不允许访问该位置。'],
            ['UNAVAILABLE', 'Caxri 尚未就绪。'],
            ['INTERNAL', '发生内部错误。'],
        ] as const)(
            'maps %s to a localized reason and keeps the raw text as detail',
            (code, reason) => {
                expect(
                    describeFailureNotice(
                        new CaxriError(code, 'Branch main already exists'),
                        '重命名失败',
                        translate,
                    ),
                ).toEqual({
                    message: `重命名失败：${reason}`,
                    detail: 'Branch main already exists',
                });
            },
        );

        it('never leaves English or an English period in the toast sentence', () => {
            const { message } = describeFailureNotice(
                new Error('socket hang up'),
                '保存失败',
                translate,
            );
            expect(message).toBe('保存失败：无法完成该操作。');
            expect(message).not.toMatch(/[A-Za-z]|\.$/u);
        });

        it('still prefers the errno reason, which already names the cause', () => {
            const error = Object.assign(new Error("ENOENT: open '/tmp/a.txt'"), { code: 'ENOENT' });
            expect(describeFailureNotice(error, '保存失败', translate).message).toBe(
                '保存失败：该文件已不存在。',
            );
        });

        it('names a binary file instead of the misleading IO reason', () => {
            const error = new CaxriError('IO', 'Binary files cannot be opened in the editor');
            expect(describeFailureNotice(error, '无法打开文件', translate).message).toBe(
                '无法打开文件：二进制文件无法在编辑器中打开。',
            );
        });

        it('tryCommand offers the hidden raw text through Copy details', async () => {
            await tryCommand('保存失败', () =>
                Promise.reject(new CaxriError('CONFLICT', 'Branch main already exists')),
            );

            const [entry] = useNotificationStore.getState().entries;
            expect(entry.message).toBe('保存失败：与较新的更改冲突，请刷新后重试。');
            expect(entry.action).toEqual({
                id: 'diagnostics.copyFailure',
                params: { text: 'Branch main already exists' },
            });
        });
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
        expect(toasts[0]).toMatchObject({
            type: 'error',
            title: 'Save file. disk is full.',
            duration: 4_000,
        });
    });

    it('attaches the recovery action to the failed operation', async () => {
        const error = new Error('disk is full');
        const retry = vi.fn();
        installToastActions({ 'terminal.refresh': { run: retry } });
        await tryCommand('Save failed', () => Promise.reject(error), {
            recovery: (failure) => {
                expect(failure).toBe(error);
                return { id: 'terminal.refresh' };
            },
        });

        const action = getToasts()[0].action as {
            label: unknown;
            onClick: () => void;
        };
        expect(action.label).toBeDefined();
        action.onClick();
        expect(retry).toHaveBeenCalledOnce();
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
