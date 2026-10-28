import type { MainRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { shell } from 'electron';

import type { EnvironmentMonitor } from '../environment-monitor/environment-monitor';
import type { NotificationHelperControl } from './agent-notification-delivery';

/**
 * Opens System Settings at the Notifications pane (macOS 13 and later).
 */
const MACOS_NOTIFICATION_SETTINGS_URL =
    'x-apple.systempreferences:com.apple.Notifications-Settings.extension';

export interface MainNotificationMethodOptions {
    /**
     * The system-notification helper control, absent until Main finishes attaching to the Server; a request before then
     * fails clearly instead of reporting a status that was never probed.
     */
    getDesktopNotifications?():
        { environmentMonitor?: EnvironmentMonitor; helper: NotificationHelperControl } | undefined;
}

type NotificationRequest = Extract<MainRequest, { method: `notifications.${string}` }>;

export function isNotificationRequest(request: MainRequest): request is NotificationRequest {
    return request.method.startsWith('notifications.');
}

/**
 * Answers the Settings > Notifications > System notifications row: delivery status, a test banner, and the shortcut to
 * macOS's own notification settings.
 */
export async function handleNotificationRequest(
    request: NotificationRequest,
    options: MainNotificationMethodOptions,
): Promise<unknown> {
    switch (request.method) {
        case 'notifications.openSystemSettings':
            await shell.openExternal(MACOS_NOTIFICATION_SETTINGS_URL);
            return null;
        case 'notifications.helperStatus':
            return requireHelper(options).status(request.params);
        case 'notifications.sendTest':
            return requireHelper(options).sendTest(request.params);
    }
}

function requireHelper(options: MainNotificationMethodOptions): NotificationHelperControl {
    const helper = options.getDesktopNotifications?.()?.helper;
    if (!helper) throw new CaxriError('UNAVAILABLE', 'System notifications are still starting');
    return helper;
}
