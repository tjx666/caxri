import type {
    BootstrapState,
    CommanderBoard,
    CommanderIdentity,
    CommanderSnapshot,
    SessionPullRequests,
    TerminalKind,
    TerminalRecord,
} from '@caxri/protocol';
import { CaxriError, isTopLevelProject } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import { commanderBoard } from './board';
import { prepareCommanderWorkspace } from './workspace';

/**
 * Upper bound on remembered Commander Sessions. Deleted Sessions drop out on every read, so this only caps a Commander
 * that keeps creating Sessions without the user ever deleting them.
 */
const MAX_COMMANDER_SESSIONS = 1_000;

/**
 * The Commander runs Codex: the maintainer's spare quota lives there, and its lifecycle hooks already drive Session
 * activity, so board state and delegation answers work without a provider-specific path.
 */
const COMMANDER_PROVIDER = 'codex' satisfies TerminalKind;

export interface AgentCommanderServiceOptions {
    database: CaxriDatabase;
    /**
     * Creates the Terminal row, lets `beforeStart` record it, then launches it. Recording first matters: the launch
     * issues the Agent Endpoint, which reads the recorded identity to grant the Commander role.
     */
    createAndStartTerminal(
        sessionId: string,
        kind: TerminalKind,
        cwd: string,
        beforeStart: (terminal: TerminalRecord) => void,
    ): Promise<TerminalRecord>;
    now?: () => number;
    probeTerminal(terminalId: string): void;
    pullRequests(): SessionPullRequests;
    /**
     * Resumes the Commander Terminal after an app restart or a suspension. Selecting a Session is what restores
     * Workbench Terminals, and the Commander Session is never selected, so `ensure` asks for it instead.
     */
    restoreTerminals(sessionId: string): void;
    /**
     * A Workbench-shaped snapshot of exactly the Commander rows, built by the same code as `app.bootstrap`.
     */
    scopedWorkbench(identity: CommanderIdentity): BootstrapState;
    sendFullStateChange(): void;
    userDataPath: string;
}

/**
 * Owns the Agent Commander's system rows and the two things only it may do: read the cross-Project board and create
 * Sessions to delegate into. See `docs/agent-commander.md`.
 */
export class AgentCommanderService {
    private ensuring: Promise<CommanderSnapshot> | undefined;

    constructor(private readonly options: AgentCommanderServiceOptions) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private async runEnsure(): Promise<CommanderSnapshot> {
        const { database } = this.options;
        const workspacePath = await prepareCommanderWorkspace(this.options.userDataPath);
        const stored = database.getAppState('agentCommander');
        let rows = database.agentCommanderRows();
        if (!rows || database.getProject(rows.projectId)?.rootPath !== workspacePath) {
            const project =
                database.findProjectByRootPath(workspacePath) ??
                database.createProject(workspacePath);
            const { session } = database.createSession(project.id, null, undefined, {
                selection: 'preserve',
            });
            database.setAppState('agentCommander', {
                projectId: project.id,
                sessionId: session.id,
                sessionIds: stored?.sessionIds ?? [],
            });
            rows = database.agentCommanderRows()!;
        }
        if (!rows.terminalId) {
            const { projectId, sessionId, sessionIds } = rows;
            const terminal = await this.options.createAndStartTerminal(
                sessionId,
                COMMANDER_PROVIDER,
                workspacePath,
                (created) =>
                    database.setAppState('agentCommander', {
                        projectId,
                        sessionId,
                        terminalId: created.id,
                        sessionIds: [...sessionIds],
                    }),
            );
            this.options.probeTerminal(terminal.id);
        } else this.options.restoreTerminals(rows.sessionId);
        const snapshot = this.snapshot();
        if (!snapshot) throw new CaxriError('UNAVAILABLE', 'Agent Commander failed to start');
        return snapshot;
    }

    /**
     * Single-flight: the window's first request and a reload racing it must not create two Commander Terminals.
     */
    async ensure(): Promise<CommanderSnapshot> {
        const pending = (this.ensuring ??= this.runEnsure());
        try {
            return await pending;
        } finally {
            if (this.ensuring === pending) this.ensuring = undefined;
        }
    }

    snapshot(): CommanderSnapshot | null {
        const rows = this.options.database.agentCommanderRows();
        if (!rows?.terminalId) return null;
        const project = this.options.database.getProject(rows.projectId);
        if (!project) return null;
        const identity = {
            projectId: rows.projectId,
            sessionId: rows.sessionId,
            terminalId: rows.terminalId,
        };
        return {
            identity,
            workspacePath: project.rootPath,
            workbench: this.options.scopedWorkbench(identity),
        };
    }

    board(): CommanderBoard {
        const { database } = this.options;
        const sessions = database.listVisibleSessions();
        const sessionIds = new Set(sessions.map((session) => session.id));
        return commanderBoard({
            commanderSessionIds: new Set(database.agentCommanderRows()?.sessionIds),
            now: this.now(),
            projects: database.listVisibleProjects(),
            pullRequests: this.options.pullRequests(),
            sessions,
            terminals: database
                .listTerminals()
                .filter((terminal) => sessionIds.has(terminal.sessionId)),
        });
    }

    /**
     * Creates an empty Session without moving the Workbench selection. The Commander Terminal must exist: the Session
     * is recorded as the Commander's, which is what later admits delegation into it.
     */
    createSession(projectId: string): { projectId: string; sessionId: string } {
        const { database } = this.options;
        const project = database
            .listVisibleProjects()
            .find((candidate) => candidate.id === projectId);
        if (!project || !isTopLevelProject(project))
            throw new CaxriError('NOT_FOUND', 'Project is unavailable to the Agent Commander');
        const rows = database.agentCommanderRows();
        if (!rows) throw new CaxriError('UNAVAILABLE', 'Agent Commander is not running');
        const { session } = database.createSession(projectId, null, undefined, {
            selection: 'preserve',
        });
        database.setAppState('agentCommander', {
            projectId: rows.projectId,
            sessionId: rows.sessionId,
            ...(rows.terminalId && { terminalId: rows.terminalId }),
            sessionIds: [...rows.sessionIds, session.id].slice(-MAX_COMMANDER_SESSIONS),
        });
        this.options.sendFullStateChange();
        return { projectId, sessionId: session.id };
    }
}
