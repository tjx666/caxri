import process from 'node:process';

import type { ServerEvent } from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow } from 'electron';

import { createAgentNotificationDelivery } from './agent-notification-delivery';
import type { AgentNotificationCoordinator } from './agent-notifications';
import { createAgentNotificationCoordinator } from './agent-notifications';
import { createAlerterNotificationDriver } from './alerter-notification';
import type { DesktopServerConnection } from './server-connection';

interface DesktopAgentNotificationOptions {
    /**
     * Icon for the alerter fallback used by unsigned builds; see `resolveNotificationAppIconPath`.
     */
    appIconPath?: string;
    focusMainWindow: () => Promise<BrowserWindow>;
    getWindow: () => BrowserWindow | undefined;
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
    if (session) await supervisor.request('session.select', { sessionId });
}

/**
 * Binds the pure attention coordinator to Electron and the exact Desktop Server lease. A click revalidates the Session
 * before changing durable selection, so stale system notifications cannot navigate to an archived or deleted Session.
 */
export function createDesktopAgentNotifications({
    appIconPath,
    focusMainWindow,
    getWindow,
    logger,
    supervisor,
    sendEvent,
}: DesktopAgentNotificationOptions): AgentNotificationCoordinator {
    const delivery = createAgentNotificationDelivery({
        alerter: createAlerterNotificationDriver({ appIconPath }),
        forceNative: process.env.CAXRI_E2E === '1',
        logger,
    });
    return createAgentNotificationCoordinator({
        activateSession: (sessionId) =>
            activateAgentNotificationSession({ focusMainWindow, supervisor }, sessionId),
        isSessionVisible: (sessionId, selectedSessionId) => {
            const window = getWindow();
            return Boolean(
                selectedSessionId === sessionId &&
                window &&
                !window.isDestroyed() &&
                window.isVisible() &&
                !window.isMinimized() &&
                window.isFocused(),
            );
        },
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
