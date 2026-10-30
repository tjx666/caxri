import process from 'node:process';

import type { MainRequest, ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { BrowserWindow } from 'electron';
import { net } from 'electron';

import { createDesktopAgentNotifications } from '../agent-notification-runtime';
import { resolveNotificationAppIconPath } from '../app-icon';
import { createDesktopBotInboxNotifications } from '../bot-inbox-notification-runtime';
import { createDesktopDeliveryNotifications } from '../delivery-notification-runtime';
import type { EnvironmentMonitor } from '../environment-monitor';
import {
    createEnvironmentMonitor,
    createEnvironmentMonitorE2EFixture,
    readMihomoConnections,
    readMihomoNodes,
    readPublicIp,
    readPublicIpProfile,
} from '../environment-monitor';
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
    environmentMonitor: EnvironmentMonitor;
    /**
     * Status and test banner for Settings > Notifications > System notifications.
     */
    helper: NotificationHelperControl;
    /**
     * Establishes the Agent attention and environment baselines. Delivery alerts need no counterpart: the Server only
     * reports a failure that started after it observed the previous state, so there is nothing for Main to catch up
     * on.
     */
    initialize(): Promise<void>;
    observe(event: ServerEvent): void;
}

/**
 * Desktop system notification families behind one handle: Agent attention, Bot Inbox items, delivery failures, and
 * selected environment signals. They share one delivery, so the native/alerter choice is probed (a `codesign` child
 * process) and its fallback logged once per change rather than once per family, and the composition root does not need
 * to remember to fan `observe` and `dispose` out to each.
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
    const environmentFetchers =
        process.env.CAXRI_E2E === '1'
            ? createEnvironmentMonitorE2EFixture(process.env.CAXRI_E2E_ENVIRONMENT_MONITOR_SCENARIO)
            : {
                  fetchPublicIp: () => readPublicIp((url, init) => net.fetch(url, init)),
                  fetchPublicIpProfile: (ip: string, checkedAt: number) =>
                      readPublicIpProfile(ip, checkedAt, (url, init) => net.fetch(url, init)),
              };
    const environmentMonitor = createEnvironmentMonitor({
        delivery: systemNotifications,
        ...environmentFetchers,
        focusMainWindow,
        loadSettings: async () => (await supervisor.request('settings.get')).value,
        readConnections: readMihomoConnections,
        readNodes: readMihomoNodes,
    });
    return {
        environmentMonitor,
        helper: {
            sendTest: (notification) => systemNotifications.sendTest(notification),
            status: (options) => systemNotifications.status(options),
        },
        dispose: () => {
            agents.dispose();
            delivery.dispose();
            botInbox.dispose();
            environmentMonitor.dispose();
        },
        initialize: async () => {
            await Promise.all([
                agents.initialize(),
                botInbox.initialize(),
                environmentMonitor.initialize(),
            ]);
        },
        observe: (event) => {
            agents.observe(event);
            delivery.observe(event);
            botInbox.observe(event);
            environmentMonitor.observe(event);
        },
    };
}
