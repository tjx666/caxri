import type { MainRequest } from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow } from 'electron';

import type { DeliveryNotificationCoordinator } from './delivery-notifications';
import { createDeliveryNotificationCoordinator } from './delivery-notifications';
import type { AgentNotificationDelivery } from './notifications/agent-notification-delivery';

interface DesktopDeliveryNotificationOptions {
    /**
     * The process-wide delivery shared with Agent attention notifications; see `AgentNotificationDelivery`.
     */
    delivery: AgentNotificationDelivery;
    focusMainWindow: () => Promise<BrowserWindow>;
    handleMainMethod: (request: MainRequest) => Promise<unknown>;
    logger: () => StructuredLogger | undefined;
}

/**
 * Binds the pure delivery coordinator to Electron. A click focuses Caxri first so the Trusted Domains prompt appears on
 * a visible window rather than behind whatever the user was doing, then hands the URL to the ordinary `external.open`
 * path: the alert URL comes from a `gh`/`vc` response, so it must clear the same scheme and trust checks as a link
 * clicked in the Renderer.
 */
export function createDesktopDeliveryNotifications({
    delivery,
    focusMainWindow,
    handleMainMethod,
    logger,
}: DesktopDeliveryNotificationOptions): DeliveryNotificationCoordinator {
    return createDeliveryNotificationCoordinator({
        onError: (error) => {
            const errorKind = isCaxriError(error)
                ? error.code
                : error instanceof Error
                  ? error.name
                  : typeof error;
            logger()?.write('warn', logEventCatalog.projectStatus.notifyFailed, {
                fields: { errorKind },
            });
        },
        openFailure: async (url) => {
            await focusMainWindow();
            await handleMainMethod({ method: 'external.open', params: { url } });
        },
        showNotification: (notification, onClick) => delivery.show(notification, onClick),
    });
}
