import type {
    BootstrapState,
    CommanderBoard,
    CommanderIdentity,
    CommanderRunState,
    CommanderSnapshot,
    SessionPullRequests,
    TerminalKind,
    TerminalRecord,
} from '@caxri/protocol';
import { CaxriError, isTopLevelProject, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

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
    /**
     * Drops a queued Commander restore and resolves once one already spawning has finished, so a stop always acts on
     * the process that restore produced instead of racing its spawn.
     */
    cancelRestore(sessionId: string): Promise<void>;
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
    /**
     * Optional so a unit test can omit it; the composed Server always passes one.
     */
    logger?: StructuredLogger;
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
    /**
     * Announces a Commander Terminal record change, so the Workbench status bar and the Commander window re-read it.
     */
    sendTerminalChange(terminalId: string): void;
    /**
     * Kills the Commander PTY behind the restart barrier and parks the row as `detached`, keeping its screen and bound
     * Codex conversation for the next `restoreTerminals`. Resolves without effect when no process is live.
     */
    stopTerminal(terminalId: string): Promise<unknown>;
    userDataPath: string;
}

const LIVE_ACTIVITY_STATES = new Map<string, CommanderRunState>([
    ['running', 'working'],
    ['waiting', 'waiting'],
]);

/**
 * Owns the Agent Commander's system rows and the two things only it may do: read the cross-Project board and create
 * Sessions to delegate into. See `docs/agent-commander.md`.
 */
export class AgentCommanderService {
    private ensuring: Promise<CommanderSnapshot> | undefined;
    private stopping: Promise<void> | undefined;

    constructor(private readonly options: AgentCommanderServiceOptions) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private async runEnsure(): Promise<CommanderSnapshot> {
        const { database } = this.options;
        const { path: workspacePath, repoFailure } = await prepareCommanderWorkspace(
            this.options.userDataPath,
        );
        if (repoFailure)
            this.options.logger?.write(
                'warn',
                logEventCatalog.agentCommander.workspaceRepositoryFailed,
                {
                    fields: { reason: repoFailure },
                },
            );
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

    private async runStop(): Promise<void> {
        /**
         * A stop racing the first ensure waits for the Terminal it creates, so the stop is never silently lost.
         */
        try {
            await this.ensuring;
        } catch {
            // The failed ensure reports to its own caller; the stop still acts on whatever rows exist.
        }
        const rows = this.options.database.agentCommanderRows();
        if (!rows?.terminalId) return;
        await this.options.cancelRestore(rows.sessionId);
        await this.options.stopTerminal(rows.terminalId);
        this.options.sendTerminalChange(rows.terminalId);
    }

    /**
     * Single-flight: the window's first request and a reload racing it must not create two Commander Terminals.
     */
    async ensure(): Promise<CommanderSnapshot> {
        /**
         * A reopen that arrives during a stop runs after it and restores what it parked. Joining an ensure the stop is
         * itself waiting on would hand the new window a Terminal the stop is about to kill. Awaits only when a stop is
         * running: an unconditional await would yield before `ensuring` is set, and a stop issued right after this call
         * would then miss the Terminal this ensure is creating.
         */
        if (this.stopping) {
            try {
                await this.stopping;
            } catch {
                // The failed stop reports to its own caller; this ensure still starts or restores the Commander.
            }
        }
        const pending = (this.ensuring ??= this.runEnsure());
        try {
            return await pending;
        } finally {
            if (this.ensuring === pending) this.ensuring = undefined;
        }
    }

    /**
     * Idempotent: stopping a Commander that is not running changes nothing. Sessions the Commander delegated into keep
     * running; their receipts wait for the Commander's next turn.
     */
    async stop(): Promise<null> {
        const pending = (this.stopping ??= this.runStop());
        try {
            await pending;
        } finally {
            if (this.stopping === pending) this.stopping = undefined;
        }
        return null;
    }

    /**
     * Reads durable rows only, so it is safe to poll and never starts anything. The Commander is Codex inside a Shell
     * PTY, and Codex can exit while the Shell lives on, so both processes must be live. Without them it is `stopped`
     * whatever its Session last reported: a turn cut off by a stop or a quit leaves `running` behind.
     */
    status(): { state: CommanderRunState } {
        const { database } = this.options;
        const rows = database.agentCommanderRows();
        const terminal = rows?.terminalId ? database.getTerminal(rows.terminalId) : undefined;
        if (!rows || !terminal) return { state: 'stopped' };
        const shell = terminal.lastProcessState;
        if (shell !== 'starting' && shell !== 'running') return { state: 'stopped' };
        const agent = terminal.lastAgentProcessState;
        if (shell === 'starting' || agent === 'starting') return { state: 'starting' };
        if (agent !== 'running') return { state: 'stopped' };
        const activity = database.getSession(rows.sessionId)?.lastActivityState;
        return { state: (activity && LIVE_ACTIVITY_STATES.get(activity)) ?? 'idle' };
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
        const rows = database.agentCommanderRows();
        return commanderBoard({
            commanderSessionIds: new Set(rows?.sessionIds),
            now: this.now(),
            projects: database.listVisibleProjects(),
            pullRequests: this.options.pullRequests(),
            sessions,
            tasks: database.agentDelegations
                .receiptsForSessions(rows?.sessionIds ?? [])
                .filter((task) => task.callerTerminalId === rows?.terminalId),
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
