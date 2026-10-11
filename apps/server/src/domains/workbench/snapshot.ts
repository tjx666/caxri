import type {
    AutomaticNamingNotice,
    BootstrapState,
    CommanderIdentity,
    ProjectRecord,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';

import type { ConfigService } from '../config';
import type { CaxriDatabase } from '../db';

/**
 * Builds the Workbench read models: the full `app.bootstrap`, targeted `app.records`, and the Agent Commander's scoped
 * snapshot. One builder keeps the three from drifting on which rows a window may see.
 */
export function createWorkbenchSnapshots(dependencies: {
    automaticNamingNotices: () => AutomaticNamingNotice[];
    configuration: ConfigService;
    database: CaxriDatabase;
    liveTerminalRecord: (terminal: TerminalRecord) => TerminalRecord;
}) {
    const { configuration, database, liveTerminalRecord } = dependencies;
    function workbenchState(
        projects: ProjectRecord[],
        sessions: SessionRecord[],
        selection: Pick<BootstrapState, 'selectedProjectId' | 'selectedSessionId'>,
    ): BootstrapState {
        const settings = configuration.getSettings();
        const keybindings = configuration.getKeybindings();
        const theme = configuration.getTheme();
        const visibleSessionIds = new Set(sessions.map((session) => session.id));
        // A hidden Project's Sessions keep their Terminal and layout rows, but none reaches the Workbench.
        const terminalRecords = database
            .listTerminals()
            .filter((terminal) => visibleSessionIds.has(terminal.sessionId));
        const notices = dependencies.automaticNamingNotices();
        return {
            projects,
            sessions,
            terminals: terminalRecords.map(liveTerminalRecord),
            ...selection,
            sessionStates: database
                .listSessionStates(terminalRecords)
                .filter((state) => visibleSessionIds.has(state.sessionId)),
            settings: settings.value,
            keybindings: keybindings.value,
            keybindingConflicts: keybindings.conflicts,
            configurationErrors: configuration.getErrors(),
            theme: theme.value,
            runtime: { status: 'ready', restartCount: 0 },
            ...(notices.length > 0 && { automaticNamingUnavailable: notices }),
        };
    }
    return {
        bootstrap: (): BootstrapState =>
            workbenchState(database.listVisibleProjects(), database.listVisibleSessions(), {
                selectedProjectId: database.getAppState('lastSelectedProjectId') ?? undefined,
                selectedSessionId: database.getAppState('lastSelectedSessionId') ?? undefined,
            }),
        /**
         * Targeted refreshes append records the Workbench did not hold yet, so the Agent Commander's own Session and
         * Terminal are withheld here exactly as `bootstrap` withholds them; the Commander window reads them through
         * `commander.snapshot` instead.
         */
        records: (sessionIds: readonly string[], terminalIds: readonly string[]) => {
            const commanderSessionId = database.agentCommanderRows()?.sessionId;
            return {
                sessions: [...new Set(sessionIds)].flatMap((sessionId) => {
                    const session = database.getSession(sessionId);
                    return session && session.id !== commanderSessionId ? [session] : [];
                }),
                terminals: [...new Set(terminalIds)].flatMap((terminalId) => {
                    const terminal = database.getTerminal(terminalId);
                    return terminal && terminal.sessionId !== commanderSessionId
                        ? [liveTerminalRecord(terminal)]
                        : [];
                }),
            };
        },
        /**
         * The Commander window's Workbench: only the Commander rows, with its own Session selected so the ordinary
         * Terminal pane treats it as the visible Session.
         */
        commander: (identity: CommanderIdentity): BootstrapState => {
            const project = database.getProject(identity.projectId);
            const session = database.getSession(identity.sessionId);
            return workbenchState(project ? [project] : [], session ? [session] : [], {
                selectedProjectId: identity.projectId,
                selectedSessionId: identity.sessionId,
            });
        },
    };
}
