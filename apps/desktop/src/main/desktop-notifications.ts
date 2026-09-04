import type { MainRequest, ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { BrowserWindow } from 'electron';

import { createDesktopAgentNotifications } from './agent-notification-runtime';
import { resolveNotificationAppIconPath } from './app-icon';
import { createDesktopDeliveryNotifications } from './delivery-notification-runtime';
import type { DesktopServerConnection } from './server-connection';

interface DesktopNotificationOptions {
    currentDirectory: string;
    focusMainWindow: () => Promise<BrowserWindow>;
    getWindow: () => BrowserWindow | undefined;
    handleMainMethod: (request: MainRequest) => Promise<unknown>;
    isPackaged: boolean;
    logger: () => StructuredLogger | undefined;
    resourcesPath: string;
    supervisor: DesktopServerConnection;
}

export interface DesktopNotifications {
    dispose(): void;
    /**
     * Establishes the Agent attention baseline. Delivery alerts need no counterpart: the Server only reports a failure
     * that started after it observed the previous state, so there is nothing for Main to catch up on.
     */
    initialize(): Promise<void>;
    observe(event: ServerEvent): void;
}

/**
 * Both families of system notification Caxri raises, behind one handle: Agent attention (a Session wants you back) and
 * delivery failures (CI or a Vercel deployment just broke). They share the icon resolution and the native/alerter
 * delivery choice, and the composition root should not have to remember to fan `observe` and `dispose` out to each.
 */
export function createDesktopNotifications({
    currentDirectory,
    focusMainWindow,
    getWindow,
    handleMainMethod,
    isPackaged,
    logger,
    resourcesPath,
    supervisor,
}: DesktopNotificationOptions): DesktopNotifications {
    const appIconPath = resolveNotificationAppIconPath({
        currentDirectory,
        isPackaged,
        resourcesPath,
    });
    const agents = createDesktopAgentNotifications({
        appIconPath,
        focusMainWindow,
        getWindow,
        logger,
        supervisor,
    });
    const delivery = createDesktopDeliveryNotifications({
        appIconPath,
        focusMainWindow,
        handleMainMethod,
        logger,
    });
    return {
        dispose: () => {
            agents.dispose();
            delivery.dispose();
        },
        initialize: () => agents.initialize(),
        observe: (event) => {
            agents.observe(event);
            delivery.observe(event);
        },
    };
}
