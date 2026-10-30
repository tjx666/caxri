import type {
    AgentProvider,
    AppSettings,
    BootstrapState,
    ServerEvent,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { agentProviderCatalog, DEFAULT_SESSION_TITLE } from '@caxri/protocol';

import { translateMain } from '../locale';

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
    /**
     * Second line under the title; Electron's macOS-only `subtitle` option and alerter's `--subtitle`.
     */
    subtitle?: string;
    title: string;
}

export interface AgentSystemNotificationHandle {
    close(): void;
}

/**
 * Why a newly raised Session attention did or did not become a banner. `shown` is the only success; every other value
 * names the single gate that stopped it, so a missing or unexpected notification can be explained from the log alone.
 */
type AgentNotificationOutcome =
    | 'shown'
    | 'archived'
    | 'read'
    | 'visible'
    | 'disabled'
    | 'noProvider'
    | 'belowThreshold'
    | 'unsupportedAttention'
    | 'settingsStale'
    /**
     * The Session changed (newer attention, read, or became visible) while the reply summary was loading.
     */
    | 'superseded';

export interface AgentNotificationDecision {
    attentionGeneration: number;
    attentionKind: SessionRecord['lastAttentionKind'];
    /**
     * Turn duration used for the completion threshold; absent when no turn start was observed.
     */
    durationMs?: number;
    outcome: AgentNotificationOutcome;
    /**
     * How the completed-turn reply summary resolved; present only for completed-turn banners that reached delivery.
     */
    replySummary?: ReplySummaryOutcome;
    sessionId: string;
}

/**
 * `included` is the only case with text; `empty` means the transcript had no closing reply (or the provider has no
 * transcript parser), `timeout` and `failed` mean the read itself did not answer.
 */
export type ReplySummaryOutcome = 'included' | 'empty' | 'timeout' | 'failed';

interface AgentNotificationCoordinatorOptions {
    activateSession(sessionId: string): Promise<void>;
    /**
     * Whether the user can see `sessionId` right now: some window renders it and is focused, visible, and not
     * minimized. Read live at each decision, not from a bootstrap, so a window that moved on or lost focus since the
     * last refresh cannot suppress a banner for a Session nobody is looking at.
     */
    isSessionVisible(sessionId: string): boolean;
    loadBootstrap(): Promise<BootstrapState>;
    loadRecords(parameters: {
        sessionIds: string[];
        terminalIds: string[];
    }): Promise<{ sessions: SessionRecord[]; terminals: TerminalRecord[] }>;
    /**
     * The Primary Agent's latest reply as one line, or `undefined` when it cannot be read. Never logged or retained.
     */
    loadReplySummary?(sessionId: string): Promise<string | undefined>;
    loadSettings(): Promise<AppSettings>;
    onNotificationsSuppressed?(count: number): void;
    /**
     * Reports once per newly raised attention epoch, never for the routine record refreshes in between.
     */
    onDecision?(decision: AgentNotificationDecision): void;
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
 * How long a completed-turn banner waits for its reply summary before falling back to the duration line. The read holds
 * the coordinator queue, so it must stay short enough that a slow transcript never delays later attention.
 */
const REPLY_SUMMARY_TIMEOUT_MS = 1_500;

/**
 * A completed turn's length as the banner prints it, in the language Main resolves for `workbench.language` (`1h 5m` in
 * English, `1 小时 5 分` in Simplified Chinese). Zero-valued trailing units are dropped.
 */
export function formatTurnDuration(durationMs: number): string {
    const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    if (hours > 0) {
        return minutes > 0
            ? translateMain('desktop.duration.hoursMinutes', { hours, minutes })
            : translateMain('desktop.duration.hours', { hours });
    }
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
        return seconds > 0
            ? translateMain('desktop.duration.minutesSeconds', { minutes, seconds })
            : translateMain('desktop.duration.minutes', { minutes });
    }
    return translateMain('desktop.duration.seconds', { seconds });
}

interface PendingBanner {
    decide(outcome: AgentNotificationOutcome, replySummary?: ReplySummaryOutcome): void;
    durationMs?: number;
    provider: AgentProvider;
    session: SessionRecord;
}

/**
 * Derives native notifications from Caxri's durable, content-free Session attention state. Startup establishes a
 * baseline instead of replaying old attention, while later reconciliations compare monotonic epochs so Renderer
 * lifetime and transient hook delivery never become notification state. The only content a banner carries is the
 * completed turn's one-line reply summary, fetched on demand and dropped once the banner is shown.
 */
export function createAgentNotificationCoordinator(
    options: AgentNotificationCoordinatorOptions,
): AgentNotificationCoordinator {
    let isInitialized = false;
    let isDisposed = false;
    let initialization: Promise<void> | undefined;
    let requiresPostInitializeReconciliation = false;
    let fullReconciliationGeneration = 0;
    /**
     * `settings.changed` carries no key, and a reconcile already waiting on records can resume before the settings
     * reload task. Keep new banners fenced until the newest reload settles; an older reload must not reopen that gate.
     */
    let settingsRefreshGeneration = 0;
    let isSettingsStale = false;
    let suppressedNotificationCount = 0;
    let settings: AppSettings | undefined;
    let tail = Promise.resolve();
    const sessions = new Map<string, SessionRecord>();
    const projectTitles = new Map<string, string>();
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

    const reportSuppressedNotifications = (): void => {
        if (suppressedNotificationCount === 0) return;
        options.onNotificationsSuppressed?.(suppressedNotificationCount);
        suppressedNotificationCount = 0;
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
            previous === undefined || session.sessionActivityAt !== previous.sessionActivityAt;
        const isNewTurnStart =
            isActivityAdvanced &&
            TURN_START_REASONS.has(session.sessionActivityReason) &&
            (session.sessionActivityReason === 'agent_started' ||
                previous?.agentActivityState !== 'running' ||
                !turnStartedAt.has(session.id));
        if (isNewTurnStart || (!previous && session.agentActivityState === 'running'))
            turnStartedAt.set(session.id, session.sessionActivityAt);
        return turnStartedAt.get(session.id);
    };

    /**
     * Applies one Session record and returns the banner it earned, if any. Showing is deferred to `deliverBanners` so
     * the synchronous gate order stays intact while a completed turn waits for its reply summary.
     */
    const reconcileSession = (
        session: SessionRecord,
        shouldNotify: boolean,
    ): PendingBanner | undefined => {
        if (isDisposed) return undefined;
        const previous = sessions.get(session.id);
        const startedAt = rememberTurnStart(session, previous);
        sessions.set(session.id, session);
        if (session.agentActivityState === 'completed' || session.agentActivityState === 'failed')
            turnStartedAt.delete(session.id);
        const isNewAttention =
            shouldNotify && session.attentionGeneration > (previous?.attentionGeneration ?? 0);
        const durationMs =
            startedAt === undefined ? undefined : session.sessionActivityAt - startedAt;
        const decide = (
            outcome: AgentNotificationOutcome,
            replySummary?: ReplySummaryOutcome,
        ): void => {
            if (!isNewAttention) return;
            options.onDecision?.({
                attentionGeneration: session.attentionGeneration,
                attentionKind: session.lastAttentionKind,
                ...(durationMs !== undefined && { durationMs }),
                outcome,
                ...(replySummary !== undefined && { replySummary }),
                sessionId: session.id,
            });
        };

        if (session.archivedAt !== undefined) {
            closeNotification(session.id);
            decide('archived');
            return undefined;
        }
        if (!session.hasUnread) {
            closeNotification(session.id);
            decide('read');
            return undefined;
        }
        if (options.isSessionVisible(session.id)) {
            closeNotification(session.id);
            decide('visible');
            return undefined;
        }
        if (!settings?.['agents.notifications.enabled']) {
            closeNotification(session.id);
            decide('disabled');
            return undefined;
        }
        if (!isNewAttention) return undefined;

        const provider = providerForSession(session);
        if (!provider) {
            closeNotification(session.id);
            decide('noProvider');
            return undefined;
        }

        if (session.lastAttentionKind === 'completed') {
            const thresholdMs = settings['agents.notifications.completionThresholdSeconds'] * 1_000;
            if (durationMs === undefined || durationMs < thresholdMs) {
                closeNotification(session.id);
                decide('belowThreshold');
                return undefined;
            }
        } else if (session.lastAttentionKind !== 'waiting') {
            closeNotification(session.id);
            decide('unsupportedAttention');
            return undefined;
        }

        if (isSettingsStale) {
            suppressedNotificationCount += 1;
            decide('settingsStale');
            return undefined;
        }

        return { decide, ...(durationMs !== undefined && { durationMs }), provider, session };
    };

    const loadReplySummary = async (
        sessionId: string,
    ): Promise<{ outcome: ReplySummaryOutcome; summary?: string }> => {
        if (!options.loadReplySummary) return { outcome: 'empty' };
        const request = async (): Promise<{ outcome: ReplySummaryOutcome; summary?: string }> => {
            try {
                const summary = await options.loadReplySummary?.(sessionId);
                return summary ? { outcome: 'included', summary } : { outcome: 'empty' };
            } catch {
                return { outcome: 'failed' };
            }
        };
        const timeout = Promise.withResolvers<{ outcome: ReplySummaryOutcome }>();
        const timer = setTimeout(
            () => timeout.resolve({ outcome: 'timeout' }),
            REPLY_SUMMARY_TIMEOUT_MS,
        );
        try {
            return await Promise.race([request(), timeout.promise]);
        } finally {
            clearTimeout(timer);
        }
    };

    const showBanner = (
        { durationMs, provider, session }: PendingBanner,
        summary: string | undefined,
    ): void => {
        const providerName = agentProviderCatalog[provider].displayName;
        const projectTitle = projectTitles.get(session.projectId);
        let body: string;
        if (session.lastAttentionKind === 'waiting')
            body = translateMain('desktop.notification.agentWaiting');
        else if (summary) body = summary;
        else
            body =
                durationMs === undefined
                    ? translateMain('desktop.notification.agentTurnFinished')
                    : translateMain('desktop.notification.agentFinishedIn', {
                          duration: formatTurnDuration(durationMs),
                      });

        closeNotification(session.id);
        const handle = options.showNotification(
            {
                id: `caxri-agent-session-${session.id}`,
                groupId: 'caxri-agent-sessions',
                /**
                 * The provider leads the title so the banner says which Agent spoke even without the sidebar's icon. An
                 * unnamed Session is announced by its provider alone rather than by the sidebar's `Untitled`.
                 */
                title:
                    session.title === DEFAULT_SESSION_TITLE
                        ? providerName
                        : `${providerName} · ${session.title}`,
                ...(projectTitle !== undefined && { subtitle: projectTitle }),
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

    /**
     * Shows the banners one reconciliation earned. A completed turn first loads its reply summary; because that read is
     * asynchronous, the Session is re-checked afterwards so a banner never announces attention the user already saw.
     */
    const deliverBanners = async (banners: Array<PendingBanner | undefined>): Promise<void> => {
        const pending = banners.filter((banner) => banner !== undefined);
        if (pending.length === 0) return;
        /**
         * Summaries load concurrently so a reconnect that surfaces several finished turns still holds the queue for one
         * timeout at most; banners are then shown in reconciliation order.
         */
        const replies = await Promise.all(
            pending.map((banner) =>
                banner.session.lastAttentionKind === 'completed'
                    ? loadReplySummary(banner.session.id)
                    : Promise.resolve(undefined),
            ),
        );
        if (isDisposed) return;
        for (const [index, banner] of pending.entries()) {
            const reply = replies[index];
            const current = sessions.get(banner.session.id);
            if (
                current?.attentionGeneration !== banner.session.attentionGeneration ||
                !current.hasUnread ||
                options.isSessionVisible(current.id) ||
                !settings?.['agents.notifications.enabled']
            ) {
                // The previous turn's banner is just as stale as the one being dropped.
                if (current?.attentionGeneration === banner.session.attentionGeneration)
                    closeNotification(banner.session.id);
                banner.decide('superseded', reply?.outcome);
                continue;
            }
            banner.decide('shown', reply?.outcome);
            showBanner(banner, reply?.summary);
        }
    };

    const applyBootstrap = (
        bootstrap: BootstrapState,
        shouldNotify: boolean,
    ): Array<PendingBanner | undefined> => {
        settings = bootstrap.settings;
        projectTitles.clear();
        for (const project of bootstrap.projects) projectTitles.set(project.id, project.title);
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
        return bootstrap.sessions.map((session) => reconcileSession(session, shouldNotify));
    };

    const reconcileFull = async (): Promise<void> => {
        await deliverBanners(applyBootstrap(await options.loadBootstrap(), true));
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
        await deliverBanners(records.sessions.map((session) => reconcileSession(session, true)));
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
                const generation = ++settingsRefreshGeneration;
                isSettingsStale = true;
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
                        if (generation === settingsRefreshGeneration) {
                            isSettingsStale = false;
                            reportSuppressedNotifications();
                        }
                        closeAllNotifications();
                        throw error;
                    }
                    settings = next;
                    if (generation === settingsRefreshGeneration) {
                        isSettingsStale = false;
                        reportSuppressedNotifications();
                    }
                    /**
                     * A `settings.changed` event carries only its source, never the changed key, so this handler must
                     * not tear banners down on arrival: a theme, a Terminal font size, or a keybinding reaches the same
                     * event, and closing eagerly made a background Agent's banner disappear while the user was still
                     * expected to act on it. Only the reloaded `enabled` value decides.
                     *
                     * Turning notifications off clears the banners. Turning them back on deliberately does not replay
                     * them: `sessions` keeps each Session's `attentionGeneration` while notifications are disabled, so
                     * the next banner needs a genuinely newer epoch. Re-issuing here would resurface attention the user
                     * has already seen in the Sidebar's unread state.
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
