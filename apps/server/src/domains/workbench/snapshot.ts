import type {
    ArchivedTerminal,
    AutomaticNamingNotice,
    BootstrapState,
    BotIdentity,
    ProjectRecord,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { ConfigService } from '../config';
import type { CaxriDatabase } from '../db';

/**
 * Builds the Workbench read models: the full `app.bootstrap`, targeted `app.records`, and Caxri Bot's scoped snapshot.
 * One builder keeps the three from drifting on which rows a window may see.
 */
export function createWorkbenchSnapshots(dependencies: {
    automaticNamingNotices: () => AutomaticNamingNotice[];
    configuration: ConfigService;
    database: CaxriDatabase;
    liveTerminalRecord: (terminal: TerminalRecord) => TerminalRecord;
    /**
     * Receives one `workbench_snapshot.built` record per snapshot with row counts and build time, never row contents.
     */
    logger?: StructuredLogger;
}) {
    const { configuration, database, liveTerminalRecord } = dependencies;
    function workbenchState(
        projects: ProjectRecord[],
        sessions: SessionRecord[],
        selection: Pick<
            BootstrapState,
            | 'openSessionIds'
            | 'otherWindowOpenSessionIds'
            | 'selectedProjectId'
            | 'selectedSessionId'
        >,
    ): BootstrapState {
        const startedAt = performance.now();
        const settings = configuration.getSettings();
        const keybindings = configuration.getKeybindings();
        const theme = configuration.getTheme();
        const visibleSessionIds = new Set(sessions.map((session) => session.id));
        // A hidden Project's Sessions keep their Terminal and layout rows, but none reaches the Workbench.
        // Archived Sessions keep their record and a slim Terminal summary (the Archived Sessions dialog and Chat draft
        // retention read it) but no full Terminal rows and no `session_state`: `session.unarchive` sends a full refresh
        // that brings both back.
        const archivedSessionIds = new Set(
            sessions.filter((session) => session.archivedAt !== undefined).map(({ id }) => id),
        );
        const terminalRecords: TerminalRecord[] = [];
        const archivedTerminals: ArchivedTerminal[] = [];
        for (const terminal of database.listTerminals()) {
            if (!visibleSessionIds.has(terminal.sessionId)) continue;
            if (archivedSessionIds.has(terminal.sessionId)) {
                archivedTerminals.push({
                    id: terminal.id,
                    kind: terminal.kind,
                    orderIndex: terminal.orderIndex,
                    sessionId: terminal.sessionId,
                    ...(terminal.surface && { surface: terminal.surface }),
                });
            } else terminalRecords.push(terminal);
        }
        const notices = dependencies.automaticNamingNotices();
        const sessionStates = database
            .listSessionStates(terminalRecords, true)
            .filter((state) => visibleSessionIds.has(state.sessionId));
        const archivedSessionCount = archivedSessionIds.size;
        const state: BootstrapState = {
            projects,
            sessions,
            terminals: terminalRecords.map(liveTerminalRecord),
            archivedTerminals,
            ...selection,
            sessionStates,
            settings: settings.value,
            keybindings: keybindings.value,
            keybindingConflicts: keybindings.conflicts,
            configurationErrors: configuration.getErrors(),
            theme: theme.value,
            runtime: { status: 'ready', restartCount: 0 },
            ...(notices.length > 0 && { automaticNamingUnavailable: notices }),
        };
        // Row counts only: they show which table dominates a slow `app.bootstrap` without recording any content.
        dependencies.logger?.write('info', logEventCatalog.workbenchSnapshot.built, {
            durationMs: Math.round(performance.now() - startedAt),
            fields: {
                archivedSessions: archivedSessionCount,
                sessions: sessions.length - archivedSessionCount,
                sessionStates: sessionStates.length,
                archivedTerminals: archivedTerminals.length,
                terminals: terminalRecords.length,
            },
        });
        return state;
    }
    return {
        /**
         * The Workbench for one window: `selectedSessionId` and `openSessionIds` come from that window's record, with
         * every entry that is archived, deleted, or hidden dropped, because the stored strip is a working set and never
         * the authority on whether a Session exists.
         */
        bootstrap: (windowKey?: string): BootstrapState => {
            const sessions = database.listVisibleSessions();
            const openable = new Set(
                sessions.filter((session) => session.archivedAt === undefined).map(({ id }) => id),
            );
            // A caller without a window (CLI, internal reads) has no strip and no active Session of its own.
            const window = windowKey
                ? database.windowOpenSessions.get(windowKey)
                : { openSessionIds: [], activeSessionId: null };
            const openSessionIds = window.openSessionIds.filter((id) => openable.has(id));
            const selectedSessionId =
                window.activeSessionId !== null && openable.has(window.activeSessionId)
                    ? window.activeSessionId
                    : undefined;
            const selectedProjectId = selectedSessionId
                ? sessions.find((session) => session.id === selectedSessionId)?.projectId
                : undefined;
            return workbenchState(database.listVisibleProjects(), sessions, {
                openSessionIds,
                otherWindowOpenSessionIds: windowKey
                    ? database.windowOpenSessions
                          .ownedElsewhere(windowKey)
                          .filter((id) => openable.has(id))
                    : [],
                selectedProjectId:
                    selectedProjectId ?? database.getAppState('lastSelectedProjectId') ?? undefined,
                selectedSessionId,
            });
        },
        /**
         * Targeted refreshes append records the Workbench did not hold yet, so Caxri Bot's own Session and Terminal are
         * withheld here exactly as `bootstrap` withholds them; Caxri Bot's window reads them through `bot.snapshot`
         * instead.
         */
        records: (sessionIds: readonly string[], terminalIds: readonly string[]) => {
            const botSessionId = database.caxriBotRows()?.sessionId;
            return {
                sessions: [...new Set(sessionIds)].flatMap((sessionId) => {
                    const session = database.getSession(sessionId);
                    return session && session.id !== botSessionId ? [session] : [];
                }),
                terminals: [...new Set(terminalIds)].flatMap((terminalId) => {
                    const terminal = database.getTerminal(terminalId);
                    return terminal && terminal.sessionId !== botSessionId
                        ? [liveTerminalRecord(terminal)]
                        : [];
                }),
            };
        },
        /**
         * Caxri Bot window's Workbench: only Caxri Bot's rows, with its own Session selected so the ordinary Terminal
         * pane treats it as the visible Session.
         */
        bot: (identity: BotIdentity): BootstrapState => {
            const project = database.getProject(identity.projectId);
            const session = database.getSession(identity.sessionId);
            return workbenchState(project ? [project] : [], session ? [session] : [], {
                openSessionIds: [identity.sessionId],
                selectedProjectId: identity.projectId,
                selectedSessionId: identity.sessionId,
            });
        },
    };
}
