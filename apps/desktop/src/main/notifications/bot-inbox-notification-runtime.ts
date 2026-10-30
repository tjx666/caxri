import type { MainRequest } from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { BrowserWindow } from 'electron';

import type { DesktopServerConnection } from '../connection/server-connection';
import type { AgentNotificationDelivery } from './agent-notification-delivery';
import type { BotInboxNotificationCoordinator } from './bot-inbox-notifications';
import { createBotInboxNotificationCoordinator } from './bot-inbox-notifications';

interface DesktopBotInboxNotificationOptions {
    /**
     * The process-wide delivery shared with the other notification families; see `AgentNotificationDelivery`.
     */
    delivery: AgentNotificationDelivery;
    handleMainMethod: (request: MainRequest) => Promise<unknown>;
    logger: () => StructuredLogger | undefined;
    supervisor: DesktopServerConnection;
}

/**
 * True when the focused window renders Caxri Bot's page. Matching the page keeps this module independent of the window
 * controller, which the composition root creates later and replaces on every reopen.
 */
function isCaxriBotWindowFocused(): boolean {
    const window = BrowserWindow.getFocusedWindow();
    if (!window || window.isDestroyed()) return false;
    try {
        return new URL(window.webContents.getURL()).pathname.endsWith('/caxri-bot.html');
    } catch {
        return false;
    }
}

/**
 * Binds the Bot Inbox coordinator to Electron. A click goes through the ordinary `caxriBot.open` Main method, so it
 * opens (or focuses) Caxri Bot's window with its Inbox shown exactly like the status-bar chip does.
 */
export function createDesktopBotInboxNotifications({
    delivery,
    handleMainMethod,
    logger,
    supervisor,
}: DesktopBotInboxNotificationOptions): BotInboxNotificationCoordinator {
    return createBotInboxNotificationCoordinator({
        isBotFocused: isCaxriBotWindowFocused,
        loadInbox: async () => (await supervisor.request('bot.inbox.list', {})).items,
        loadSettings: async () => (await supervisor.request('settings.get')).value,
        onDecision: ({ itemCount, outcome }) => {
            logger()?.write('info', logEventCatalog.agentNotifications.decided, {
                fields: { attentionKind: 'botInbox', itemCount, outcome },
            });
        },
        onError: (error) => {
            const errorKind = isCaxriError(error)
                ? error.code
                : error instanceof Error
                  ? error.name
                  : typeof error;
            logger()?.write('warn', logEventCatalog.agentNotifications.operationFailed, {
                fields: { errorKind },
            });
        },
        openInbox: async () => {
            await handleMainMethod({ method: 'caxriBot.open', params: { target: 'inbox' } });
        },
        showNotification: (notification, onClick) => delivery.show(notification, onClick),
    });
}
