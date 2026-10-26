import type { MainRequest } from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { BrowserWindow } from 'electron';

import type { CommanderInboxNotificationCoordinator } from './commander-inbox-notifications';
import { createCommanderInboxNotificationCoordinator } from './commander-inbox-notifications';
import type { AgentNotificationDelivery } from './notifications/agent-notification-delivery';
import type { DesktopServerConnection } from './server-connection';

interface DesktopCommanderInboxNotificationOptions {
    /**
     * The process-wide delivery shared with the other notification families; see `AgentNotificationDelivery`.
     */
    delivery: AgentNotificationDelivery;
    handleMainMethod: (request: MainRequest) => Promise<unknown>;
    logger: () => StructuredLogger | undefined;
    supervisor: DesktopServerConnection;
}

/**
 * True when the focused window renders the Agent Commander page. Matching the page keeps this module independent of the
 * window controller, which the composition root creates later and replaces on every reopen.
 */
function isAgentCommanderWindowFocused(): boolean {
    const window = BrowserWindow.getFocusedWindow();
    if (!window || window.isDestroyed()) return false;
    try {
        return new URL(window.webContents.getURL()).pathname.endsWith('/agent-commander.html');
    } catch {
        return false;
    }
}

/**
 * Binds the Commander Inbox coordinator to Electron. A click goes through the ordinary `agentCommander.open` Main
 * method, so it opens (or focuses) the Commander window with its Inbox shown exactly like the status-bar chip does.
 */
export function createDesktopCommanderInboxNotifications({
    delivery,
    handleMainMethod,
    logger,
    supervisor,
}: DesktopCommanderInboxNotificationOptions): CommanderInboxNotificationCoordinator {
    return createCommanderInboxNotificationCoordinator({
        isCommanderFocused: isAgentCommanderWindowFocused,
        loadInbox: async () => (await supervisor.request('commander.inbox.list', {})).items,
        loadSettings: async () => (await supervisor.request('settings.get')).value,
        onDecision: ({ itemCount, outcome }) => {
            logger()?.write('info', logEventCatalog.agentNotifications.decided, {
                fields: { attentionKind: 'commanderInbox', itemCount, outcome },
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
            await handleMainMethod({ method: 'agentCommander.open', params: { target: 'inbox' } });
        },
        showNotification: (notification, onClick) => delivery.show(notification, onClick),
    });
}
