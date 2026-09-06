import type {
    AppSettings,
    BootstrapState,
    ServerEvent,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { agentProviderCatalog, DEFAULT_SESSION_TITLE } from '@caxri/protocol';

/**
 * The two identity fields are real Electron `NotificationConstructorOptions` on macOS and Windows, not Caxri-private
 * bookkeeping: `id` maps to the `UNNotificationRequest` identifier, so a later banner with the same `id` replaces the
 * one still on screen, and `groupId` maps to the `threadIdentifier` that stacks Caxri's banners together in
 * Notification Center. The alerter backend reproduces the same replacement rule through its `--group` flag.
 */
export interface AgentSystemNotification {
    body: string;
    groupId: string;
    id: string;
    title: string;
}

export interface AgentSystemNotificationHandle {
    close(): void;
}

interface AgentNotificationCoordinatorOptions {
    activateSession(sessionId: string): Promise<void>;
    isSessionVisible(sessionId: string, selectedSessionId: string | undefined): boolean;
    loadBootstrap(): Promise<BootstrapState>;
    loadRecords(parameters: {
        sessionIds: string[];
        terminalIds: string[];
    }): Promise<{ sessions: SessionRecord[]; terminals: TerminalRecord[] }>;
    loadSettings(): Promise<AppSettings>;
    onError?(error: unknown): void;
    showNotification(
        notification: AgentSystemNotification,
        onClick: () => void,
    ): AgentSystemNotificationHandle | undefined;
}

export interface AgentNotificationCoordinator {
    dispose(): void;
    flush(): Promise<void>;
    initialize(): Promise<void>;
    observe(event: ServerEvent): void;
}

const TURN_START_REASONS = new Set(['user_submission', 'agent_started']);

/**
 * Derives native notifications from Caxri's durable, content-free Session attention state. Startup establishes a
 * baseline instead of replaying old attention, while later reconciliations compare monotonic epochs so Renderer
 * lifetime and transient hook delivery never become notification state.
 */
export function createAgentNotificationCoordinator(
    options: AgentNotificationCoordinatorOptions,
): AgentNotificationCoordinator {
    let isInitialized = false;
    let isDisposed = false;
    let initialization: Promise<void> | undefined;
    let requiresPostInitializeReconciliation = false;
    let fullReconciliationGeneration = 0;
    let selectedSessionId: string | undefined;
    let settings: AppSettings | undefined;
    let tail = Promise.resolve();
    const sessions = new Map<string, SessionRecord>();
    const terminals = new Map<string, TerminalRecord>();
    const turnStartedAt = new Map<string, number>();
    const notifications = new Map<string, AgentSystemNotificationHandle>();

    const closeNotification = (sessionId: string): void => {
        notifications.get(sessionId)?.close();
        notifications.delete(sessionId);
    };

    const closeAllNotifications = (): void => {
        for (const notification of notifications.values()) notification.close();
        notifications.clear();
    };

    const reportError = (error: unknown): void => {
        options.onError?.(error);
    };

    const runScheduled = async (previous: Promise<void>, task: () => Promise<void>) => {
        try {
            await previous;
            if (isDisposed) return;
            await task();
        } catch (error) {
            reportError(error);
        }
    };

    const schedule = (task: () => Promise<void>): void => {
        tail = runScheduled(tail, task);
    };

    const providerForSession = (session: SessionRecord) => {
        if (!session.primaryAgentTerminalId) return;
        return terminals.get(session.primaryAgentTerminalId)?.provider;
    };

    const rememberTurnStart = (
        session: SessionRecord,
        previous: SessionRecord | undefined,
    ): number | undefined => {
        const isActivityAdvanced =
            previous === undefined ||
            session.lastSessionActivityAt !== previous.lastSessionActivityAt;
        const isNewTurnStart =
            isActivityAdvanced &&
            TURN_START_REASONS.has(session.lastSessionActivityReason) &&
            (session.lastSessionActivityReason === 'agent_started' ||
                previous?.lastActivityState !== 'running' ||
                !turnStartedAt.has(session.id));
        if (isNewTurnStart || (!previous && session.lastActivityState === 'running'))
            turnStartedAt.set(session.id, session.lastSessionActivityAt);
        return turnStartedAt.get(session.id);
    };

    const reconcileSession = (session: SessionRecord, shouldNotify: boolean): void => {
        if (isDisposed) return;
        const previous = sessions.get(session.id);
        const startedAt = rememberTurnStart(session, previous);
        sessions.set(session.id, session);
        if (session.lastActivityState === 'completed' || session.lastActivityState === 'failed')
            turnStartedAt.delete(session.id);

        if (
            session.archivedAt !== undefined ||
            !session.hasUnread ||
            options.isSessionVisible(session.id, selectedSessionId)
        ) {
            closeNotification(session.id);
            return;
        }
        if (!settings?.['agents.notifications.enabled']) {
            closeNotification(session.id);
            return;
        }
        if (!shouldNotify || session.attentionEpoch <= (previous?.attentionEpoch ?? 0)) return;

        closeNotification(session.id);
        const provider = providerForSession(session);
        if (!provider) return;

        let body: string;
        if (session.lastAttentionKind === 'waiting') {
            body = `${agentProviderCatalog[provider].displayName} is waiting for your input.`;
        } else if (session.lastAttentionKind === 'completed') {
            const durationMs =
                startedAt === undefined ? undefined : session.lastSessionActivityAt - startedAt;
            const thresholdMs = settings['agents.notifications.completionThresholdSeconds'] * 1_000;
            if (durationMs === undefined || durationMs < thresholdMs) return;
            body = `${agentProviderCatalog[provider].displayName} completed a turn.`;
        } else {
            return;
        }

        const handle = options.showNotification(
            {
                id: `caxri-agent-session-${session.id}`,
                groupId: 'caxri-agent-sessions',
                /**
                 * The sidebar keeps `Untitled` because its row already shows the provider icon, but a native banner has
                 * no such icon, so an unnamed Session is announced by its provider instead. The substitute is derived
                 * from the Terminal's provider alone and can never carry prompt or transcript content.
                 */
                title:
                    session.displayTitle === DEFAULT_SESSION_TITLE
                        ? `${agentProviderCatalog[provider].displayName} session`
                        : session.displayTitle,
                body,
            },
            () => {
                if (notifications.get(session.id) !== handle) return;
                notifications.delete(session.id);
                handle?.close();
                // Notification callbacks are synchronous; the coordinator queue owns async failure handling.
                schedule(() => options.activateSession(session.id));
            },
        );
        if (handle) notifications.set(session.id, handle);
    };

    const applyBootstrap = (bootstrap: BootstrapState, shouldNotify: boolean): void => {
        selectedSessionId = bootstrap.selectedSessionId;
        settings = bootstrap.settings;
        if (!settings['agents.notifications.enabled']) closeAllNotifications();
        terminals.clear();
        for (const terminal of bootstrap.terminals) terminals.set(terminal.id, terminal);

        const nextSessionIds = new Set(bootstrap.sessions.map((session) => session.id));
        for (const sessionId of sessions.keys()) {
            if (nextSessionIds.has(sessionId)) continue;
            sessions.delete(sessionId);
            turnStartedAt.delete(sessionId);
            closeNotification(sessionId);
        }
        for (const session of bootstrap.sessions) reconcileSession(session, shouldNotify);
    };

    const reconcileFull = async (): Promise<void> => {
        applyBootstrap(await options.loadBootstrap(), true);
    };

    const reconcileRecords = async (
        sessionIds: string[],
        terminalIds: string[],
        expectedFullGeneration: number,
    ): Promise<void> => {
        const records = await options.loadRecords({ sessionIds, terminalIds });
        /**
         * A full change may represent a Session selection made while this targeted read was in flight. Let the queued
         * bootstrap compare against the untouched epoch baseline so current visibility wins without losing a background
         * attention event.
         */
        if (fullReconciliationGeneration !== expectedFullGeneration) return;
        for (const terminalId of terminalIds) terminals.delete(terminalId);
        for (const terminal of records.terminals) terminals.set(terminal.id, terminal);
        for (const session of records.sessions) reconcileSession(session, true);
    };

    const initializeOnce = async (): Promise<void> => {
        if (isInitialized || isDisposed) return;
        try {
            applyBootstrap(await options.loadBootstrap(), false);
            isInitialized = true;
            if (requiresPostInitializeReconciliation) {
                requiresPostInitializeReconciliation = false;
                fullReconciliationGeneration += 1;
                schedule(reconcileFull);
            }
        } catch (error) {
            reportError(error);
        }
    };

    const initialize = (): Promise<void> => {
        if (isInitialized || isDisposed) return Promise.resolve();
        initialization ??= (async () => {
            try {
                await initializeOnce();
            } finally {
                initialization = undefined;
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal and bootstrap success can change while the await above is pending
                if (!isInitialized && !isDisposed && requiresPostInitializeReconciliation) {
                    // An event that arrives during a failed bootstrap must start a fresh attempt. Joining the failed
                    // in-flight promise would otherwise consume the only retry signal.
                    requiresPostInitializeReconciliation = false;
                    schedule(initialize);
                }
            }
        })();
        return initialization;
    };

    return {
        dispose(): void {
            isDisposed = true;
            closeAllNotifications();
        },
        flush(): Promise<void> {
            return tail;
        },
        initialize,
        observe(event: ServerEvent): void {
            if (isDisposed) return;
            if (!isInitialized) {
                if (
                    event.event === 'state.changed' ||
                    event.event === 'settings.changed' ||
                    (event.event === 'host.connectionChanged' &&
                        event.payload.status === 'reconnected')
                ) {
                    requiresPostInitializeReconciliation = true;
                    schedule(initialize);
                }
                return;
            }
            if (event.event === 'state.changed') {
                if (event.payload.kind === 'full') {
                    fullReconciliationGeneration += 1;
                    schedule(reconcileFull);
                } else {
                    const { sessionIds, terminalIds } = event.payload;
                    const relevantTerminalIds =
                        sessionIds.length > 0
                            ? terminalIds
                            : terminalIds.filter(
                                  (terminalId) => terminals.get(terminalId)?.provider !== undefined,
                              );
                    if (sessionIds.length === 0 && relevantTerminalIds.length === 0) return;
                    const expectedFullGeneration = fullReconciliationGeneration;
                    schedule(() =>
                        reconcileRecords(sessionIds, relevantTerminalIds, expectedFullGeneration),
                    );
                }
                return;
            }
            if (event.event === 'settings.changed') {
                schedule(async () => {
                    let next: AppSettings;
                    try {
                        next = await options.loadSettings();
                    } catch (error) {
                        /**
                         * Teardown is deferred until the reload answers, so a reload that never answers must fail
                         * closed here instead: without settings the coordinator cannot tell whether notifications are
                         * still permitted, and keeping banners up would outlive a disable the user just applied.
                         */
                        settings = undefined;
                        closeAllNotifications();
                        throw error;
                    }
                    settings = next;
                    /**
                     * A `settings.changed` event carries only its source, never the changed key, so this handler must
                     * not tear banners down on arrival: a theme, a Terminal font size, or a keybinding reaches the same
                     * event, and closing eagerly made a background Agent's banner disappear while the user was still
                     * expected to act on it. Only the reloaded `enabled` value decides.
                     *
                     * Turning notifications off clears the banners. Turning them back on deliberately does not replay
                     * them: `sessions` keeps each Session's `attentionEpoch` while notifications are disabled, so the
                     * next banner needs a genuinely newer epoch. Re-issuing here would resurface attention the user has
                     * already seen in the Sidebar's unread state.
                     */
                    if (!next['agents.notifications.enabled']) closeAllNotifications();
                });
                return;
            }
            if (
                event.event === 'host.connectionChanged' &&
                event.payload.status === 'reconnected'
            ) {
                fullReconciliationGeneration += 1;
                schedule(reconcileFull);
            }
        },
    };
}
