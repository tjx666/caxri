import type { ServerEvent } from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow } from 'electron';

import type { AgentNotificationDelivery } from './agent-notification-delivery';
import type { AgentNotificationCoordinator } from './agent-notifications';
import { createAgentNotificationCoordinator } from './agent-notifications';
import type { DesktopServerConnection } from './server-connection';
import { PRIMARY_WINDOW_KEY } from './window-presence-registry';

interface DesktopAgentNotificationOptions {
    /**
     * The process-wide delivery shared with delivery-failure alerts; see `AgentNotificationDelivery`.
     */
    delivery: AgentNotificationDelivery;
    focusMainWindow: (windowKey?: string) => Promise<BrowserWindow>;
    /**
     * Whether some window is showing the Session to the user right now; see `WindowPresenceRegistry.isSessionShown`.
     */
    isSessionShown: (sessionId: string) => boolean;
    logger: () => StructuredLogger | undefined;
    supervisor: DesktopServerConnection;
    sendEvent: (event: ServerEvent) => void;
}

/**
 * Focuses Caxri even when a delivered notification has gone stale, then changes selection only after the current Host
 * confirms that the exact Session still exists and remains active.
 */
export async function activateAgentNotificationSession(
    {
        focusMainWindow,
        supervisor,
    }: Pick<DesktopAgentNotificationOptions, 'focusMainWindow' | 'supervisor'>,
    sessionId: string,
): Promise<void> {
    await focusMainWindow();
    const bootstrap = await supervisor.request('app.bootstrap');
    const session = bootstrap.sessions.find(
        (candidate) => candidate.id === sessionId && candidate.archivedAt === undefined,
    );
    if (session) {
        const { ownerWindowKey } = await supervisor.request('session.select', {
            sessionId,
            windowKey: PRIMARY_WINDOW_KEY,
        });
        // A Session owned by a torn-off window is shown there; raise that window instead of the primary one.
        if (ownerWindowKey) await focusMainWindow(ownerWindowKey);
    }
}

/**
 * Binds the pure attention coordinator to Electron and the exact Desktop Server lease. A click revalidates the Session
 * before changing durable selection, so stale system notifications cannot navigate to an archived or deleted Session.
 */
export function createDesktopAgentNotifications({
    delivery,
    focusMainWindow,
    isSessionShown,
    logger,
    supervisor,
    sendEvent,
}: DesktopAgentNotificationOptions): AgentNotificationCoordinator {
    return createAgentNotificationCoordinator({
        activateSession: (sessionId) =>
            activateAgentNotificationSession({ focusMainWindow, supervisor }, sessionId),
        isSessionVisible: isSessionShown,
        loadBootstrap: () => supervisor.request('app.bootstrap'),
        loadRecords: (parameters) => supervisor.request('app.records', parameters),
        loadReplySummary: async (sessionId) =>
            (await supervisor.request('agent.replySummary', { sessionId })).summary,
        loadSettings: async () => (await supervisor.request('settings.get')).value,
        onDecision: (decision) => {
            if (
                decision.outcome === 'shown' &&
                (decision.attentionKind === 'waiting' || decision.attentionKind === 'completed')
            ) {
                sendEvent({
                    event: 'agent.notification',
                    payload: {
                        sessionId: decision.sessionId,
                        attentionKind: decision.attentionKind,
                    },
                });
            }
            logger()?.write('info', logEventCatalog.agentNotifications.decided, {
                fields: {
                    attentionEpoch: decision.attentionEpoch,
                    attentionKind: decision.attentionKind ?? null,
                    durationMs: decision.durationMs ?? null,
                    outcome: decision.outcome,
                    replySummary: decision.replySummary ?? null,
                    sessionId: decision.sessionId,
                },
            });
        },
        onNotificationsSuppressed: (count) => {
            logger()?.write('info', logEventCatalog.agentNotifications.settingsRefreshSuppressed, {
                fields: { suppressedCount: count },
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
        showNotification: (notification, onClick) => delivery.show(notification, onClick),
    });
}
