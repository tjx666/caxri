import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow } from 'electron';

import type { AgentSystemNotificationHandle } from '../agent-notifications';
import { translateMain } from '../locale';
import type { AgentNotificationDelivery } from '../notifications/agent-notification-delivery';
import type { EnvironmentMonitor } from './monitor';

const NOTIFICATION_ID = 'caxri-environment-monitor';

interface DesktopEnvironmentMonitorNotificationOptions {
    delivery: AgentNotificationDelivery;
    focusMainWindow: () => Promise<BrowserWindow>;
    logger: () => StructuredLogger | undefined;
    monitor: EnvironmentMonitor;
}

/**
 * Turns each new monitor issue set into one replaceable system banner. The monitor owns transition deduplication; this
 * adapter owns only delivery, focus, and teardown.
 */
export function createDesktopEnvironmentMonitorNotifications({
    delivery,
    focusMainWindow,
    logger,
    monitor,
}: DesktopEnvironmentMonitorNotificationOptions): { dispose(): void } {
    let notification: AgentSystemNotificationHandle | undefined;
    const unsubscribe = monitor.subscribeAlerts((event) => {
        notification?.close();
        notification = undefined;
        if (event.type === 'clear') return;
        const { state } = event;
        const count = state.issues.length;
        notification = delivery.show(
            {
                body: translateMain('desktop.environmentMonitor.notification.body', { count }),
                groupId: NOTIFICATION_ID,
                id: NOTIFICATION_ID,
                title: translateMain('desktop.environmentMonitor.notification.title'),
            },
            () => {
                void focusMainWindow().catch((error: unknown) => {
                    logger()?.write('warn', logEventCatalog.environmentMonitor.notificationFailed, {
                        fields: {
                            errorKind: error instanceof Error ? error.name : typeof error,
                        },
                    });
                });
            },
        );
    });
    return {
        dispose() {
            unsubscribe();
            notification?.close();
            notification = undefined;
        },
    };
}
