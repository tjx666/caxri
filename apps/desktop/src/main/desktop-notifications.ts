import process from 'node:process';

import type { MainRequest, ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { BrowserWindow } from 'electron';

import { createAgentNotificationDelivery } from './agent-notification-delivery';
import { createDesktopAgentNotifications } from './agent-notification-runtime';
import { createAlerterNotificationDriver } from './alerter-notification';
import { resolveNotificationAppIconPath } from './app-icon';
import { createDesktopCommanderInboxNotifications } from './commander-inbox-notification-runtime';
import { createDesktopDeliveryNotifications } from './delivery-notification-runtime';
import type { DesktopServerConnection } from './server-connection';

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
     * Establishes the Agent attention baseline. Delivery alerts need no counterpart: the Server only reports a failure
     * that started after it observed the previous state, so there is nothing for Main to catch up on.
     */
    initialize(): Promise<void>;
    observe(event: ServerEvent): void;
}

/**
 * Both families of system notification Caxri raises, behind one handle: Agent attention (a Session wants you back), the
 * Commander Inbox (the Agent Commander raised something for you), and delivery failures (CI or a Vercel deployment just
 * broke). They share one delivery, so the native/alerter choice is probed (a `codesign` child process) and its fallback
 * logged once per launch rather than once per family, and the composition root should not have to remember to fan
 * `observe` and `dispose` out to each.
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
    const commanderInbox = createDesktopCommanderInboxNotifications({
        delivery: systemNotifications,
        handleMainMethod,
        logger,
        supervisor,
    });
    return {
        dispose: () => {
            agents.dispose();
            delivery.dispose();
            commanderInbox.dispose();
        },
        initialize: async () => {
            await Promise.all([agents.initialize(), commanderInbox.initialize()]);
        },
        observe: (event) => {
            agents.observe(event);
            delivery.observe(event);
            commanderInbox.observe(event);
        },
    };
}
