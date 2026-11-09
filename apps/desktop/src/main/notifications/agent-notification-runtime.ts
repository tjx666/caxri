import type { ServerEvent, SessionRecord } from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow } from 'electron';

import type { DesktopServerConnection } from '../connection/server-connection';
import { PRIMARY_WINDOW_KEY } from '../window-presence-registry';
import type { AgentNotificationDelivery } from './agent-notification-delivery';
import type { AgentNotificationCoordinator } from './agent-notifications';
import { createAgentNotificationCoordinator } from './agent-notifications';

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
 * The longest consult chain the redirect follows; real chains are one or two deep, the cap only stops a corrupt cycle.
 */
const MAX_CONSULT_CREATOR_WALK = 16;

/**
 * The Session a notification click selects: the Session itself, or for a `consult` its nearest active creator that is
 * not itself a consult. A consult takes no Project tree row while its creator is active; the asking Chat's Delegated
 * Sessions strip is its entry. Selecting the consult would make it appear in the sidebar only until the user moved on
 * (`placeDelegatedSessions` nests the selected consult so the selection stays visible). A consult whose creator is
 * archived or deleted keeps its own selection, as the command palette does.
 */
function notificationTargetSession(
    sessions: readonly SessionRecord[],
    session: SessionRecord,
): SessionRecord {
    const activeById = new Map(
        sessions
            .filter((candidate) => candidate.archivedAt === undefined)
            .map((candidate) => [candidate.id, candidate]),
    );
    let target = session;
    for (let depth = 0; depth < MAX_CONSULT_CREATOR_WALK; depth += 1) {
        if (target.createdByRelation !== 'consult') return target;
        const creator = activeById.get(target.createdBySessionId ?? '');
        if (creator === undefined) return target;
        target = creator;
    }
    return session;
}

/**
 * Focuses Caxri even when a delivered notification has gone stale, then changes selection only after the current Host
 * confirms that the exact Session still exists and remains active. A consult's notification selects the Chat that asked
 * for it instead (see `notificationTargetSession`).
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
            sessionId: notificationTargetSession(bootstrap.sessions, session).id,
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
                    attentionGeneration: decision.attentionGeneration,
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
