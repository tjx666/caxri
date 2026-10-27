import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ openExternal: vi.fn(() => Promise.resolve()) }));
vi.mock('electron', () => ({ shell: { openExternal: electron.openExternal } }));

import type { NotificationHelperControl } from '../agent-notification-delivery';
import { handleNotificationRequest, isNotificationRequest } from '../main-notification-methods';

function helper() {
    const sendTest = vi.fn<NotificationHelperControl['sendTest']>(() =>
        Promise.resolve({ delivery: 'basic' as const, sent: true }),
    );
    const status = vi.fn<NotificationHelperControl['status']>(() =>
        Promise.resolve({ delivery: 'helper' as const }),
    );
    return { control: { sendTest, status }, sendTest, status };
}

describe('Main notification methods', () => {
    it('recognizes only notifications.* requests', () => {
        expect(isNotificationRequest({ method: 'notifications.helperStatus', params: {} })).toBe(
            true,
        );
        expect(isNotificationRequest({ method: 'argv.get', params: {} })).toBe(false);
    });

    it('passes the recheck flag through and answers with the helper status', async () => {
        const { control, status } = helper();

        await expect(
            handleNotificationRequest(
                { method: 'notifications.helperStatus', params: { recheck: true } },
                { getDesktopNotifications: () => ({ helper: control }) },
            ),
        ).resolves.toEqual({ delivery: 'helper' });
        expect(status).toHaveBeenCalledWith({ recheck: true });
    });

    it('sends the test banner words the Renderer supplied', async () => {
        const { control, sendTest } = helper();

        await handleNotificationRequest(
            { method: 'notifications.sendTest', params: { body: 'Body', title: 'Title' } },
            { getDesktopNotifications: () => ({ helper: control }) },
        );

        expect(sendTest).toHaveBeenCalledWith({ body: 'Body', title: 'Title' });
    });

    it('fails clearly before notifications are set up', async () => {
        await expect(
            handleNotificationRequest({ method: 'notifications.helperStatus', params: {} }, {}),
        ).rejects.toThrow('still starting');
    });

    it('opens the fixed macOS Notifications pane', async () => {
        await handleNotificationRequest(
            { method: 'notifications.openSystemSettings', params: {} },
            {},
        );

        expect(electron.openExternal).toHaveBeenCalledWith(
            'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
        );
    });
});
