import process from 'node:process';

import type { MainRequest, ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { BrowserWindow } from 'electron';

import { createDesktopAgentNotifications } from '../agent-notification-runtime';
import { resolveNotificationAppIconPath } from '../app-icon';
import { createDesktopBotInboxNotifications } from '../bot-inbox-notification-runtime';
import { createDesktopDeliveryNotifications } from '../delivery-notification-runtime';
import type { DesktopServerConnection } from '../server-connection';
import type { NotificationHelperControl } from './agent-notification-delivery';
import { createAgentNotificationDelivery } from './agent-notification-delivery';
import { createAlerterNotificationDriver } from './alerter-notification';

interface DesktopNotificationOptions {
    currentDirectory: string;
    focusMainWindow: (windowKey?: string) => Promise<BrowserWindow>;
    isSessionShown: (sessionId: string) => boolean;
    handleMainMethod: (request: MainRequest) => Promise<unknown>;
    isPackaged: boolean;
    logger: () => StructuredLogger | undefined;
    resourcesPath: string;
    supervisor: DesktopServerConnection;
    sendEvent: (event: ServerEvent) => void;
}

export interface DesktopNotifications {
    dispose(): void;
    /**
     * Status and test banner for Settings > Notifications > System notifications.
     */
    helper: NotificationHelperControl;
    /**
     * Establishes the Agent attention baseline. Delivery alerts need no counterpart: the Server only reports a failure
     * that started after it observed the previous state, so there is nothing for Main to catch up on.
     */
    initialize(): Promise<void>;
    observe(event: ServerEvent): void;
}

/**
 * Both families of system notification Caxri raises, behind one handle: Agent attention (a Session wants you back), the
 * Bot Inbox (Caxri Bot raised something for you), and delivery failures (CI or a Vercel deployment just broke). They
 * share one delivery, so the native/alerter choice is probed (a `codesign` child process) and its fallback logged once
 * per change rather than once per family, and the composition root should not have to remember to fan `observe` and
 * `dispose` out to each.
 */
export function createDesktopNotifications({
    currentDirectory,
    focusMainWindow,
    handleMainMethod,
    isSessionShown,
    isPackaged,
    logger,
    resourcesPath,
    supervisor,
    sendEvent,
}: DesktopNotificationOptions): DesktopNotifications {
    const appIconPath = resolveNotificationAppIconPath({
        currentDirectory,
        isPackaged,
        resourcesPath,
    });
    const systemNotifications = createAgentNotificationDelivery({
        alerter: createAlerterNotificationDriver({ appIconPath }),
        forceNative: process.env.CAXRI_E2E === '1',
        logger,
        onHelperUnavailable: () =>
            sendEvent({ event: 'notifications.helperUnavailable', payload: {} }),
    });
    const agents = createDesktopAgentNotifications({
        sendEvent,
        delivery: systemNotifications,
        focusMainWindow,
        isSessionShown,
        logger,
        supervisor,
    });
    const delivery = createDesktopDeliveryNotifications({
        delivery: systemNotifications,
        focusMainWindow,
        handleMainMethod,
        logger,
    });
    const botInbox = createDesktopBotInboxNotifications({
        delivery: systemNotifications,
        handleMainMethod,
        logger,
        supervisor,
    });
    return {
        helper: {
            sendTest: (notification) => systemNotifications.sendTest(notification),
            status: (options) => systemNotifications.status(options),
        },
        dispose: () => {
            agents.dispose();
            delivery.dispose();
            botInbox.dispose();
        },
        initialize: async () => {
            await Promise.all([agents.initialize(), botInbox.initialize()]);
        },
        observe: (event) => {
            agents.observe(event);
            delivery.observe(event);
            botInbox.observe(event);
        },
    };
}
