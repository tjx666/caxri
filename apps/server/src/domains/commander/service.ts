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
import { agentCommanderTerminal } from '../db';
import { commanderBoard } from './board';
import { commanderHandovers } from './handover-records';
import { CommanderTaskLedger } from './tasks';
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
    /**
     * Runs after a stop parked the Commander, so the turn the user deliberately stopped is not resumed on the next
     * launch. Optional so a unit test can omit it.
     */
    onStopped?(): void;
    /**
     * Runs right before `ensure` starts or restores the Commander process, so work it missed while stopped
     * (unacknowledged Inbox replies) is queued in time for the launch prompt to carry it.
     */
    onLaunching?(): void;
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
    readonly tasks: CommanderTaskLedger;

    constructor(private readonly options: AgentCommanderServiceOptions) {
        this.tasks = new CommanderTaskLedger(options.database, () => this.now(), options.logger);
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private async runEnsure(): Promise<CommanderSnapshot> {
        const { database } = this.options;
        const startedAt = performance.now();
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
            this.options.onLaunching?.();
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
            this.logEnsured('created', terminal.id, startedAt);
        } else {
            const state = database.getTerminal(rows.terminalId)?.lastProcessState;
            const isRunning = state === 'running' || state === 'starting';
            if (!isRunning) this.options.onLaunching?.();
            this.options.restoreTerminals(rows.sessionId);
            this.logEnsured(isRunning ? 'running' : 'restored', rows.terminalId, startedAt, state);
        }
        const snapshot = this.snapshot();
        if (!snapshot) throw new CaxriError('UNAVAILABLE', 'Agent Commander failed to start');
        return snapshot;
    }

    private logEnsured(
        outcome: 'created' | 'restored' | 'running',
        terminalId: string,
        startedAt: number,
        previousState?: string,
    ): void {
        this.options.logger?.write('info', logEventCatalog.agentCommander.ensured, {
            fields: {
                outcome,
                terminalId,
                previousState: previousState ?? null,
                durationMs: Math.round(performance.now() - startedAt),
            },
        });
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
        if (!rows?.terminalId) {
            this.options.logger?.write('info', logEventCatalog.agentCommander.stopped, {
                fields: { outcome: 'not_running' },
            });
            return;
        }
        const startedAt = performance.now();
        await this.options.cancelRestore(rows.sessionId);
        await this.options.stopTerminal(rows.terminalId);
        this.options.onStopped?.();
        this.options.sendTerminalChange(rows.terminalId);
        this.options.logger?.write('info', logEventCatalog.agentCommander.stopped, {
            fields: {
                outcome: 'stopped',
                terminalId: rows.terminalId,
                durationMs: Math.round(performance.now() - startedAt),
            },
        });
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
        return { state: commanderRunState(this.options.database) };
    }

    snapshot(): CommanderSnapshot | null {
        const identity = agentCommanderTerminal(this.options.database);
        if (!identity) return null;
        const project = this.options.database.getProject(identity.projectId);
        if (!project) return null;
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
            handovers: commanderHandovers(database),
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
            commanderTasks: this.tasks.list({ includeClosed: false }),
        });
    }

    /**
     * Creates an empty Session without moving the Workbench selection; see {@link createCommanderSession}.
     */
    createSession(projectId: string): { projectId: string; sessionId: string } {
        const sessionId = createCommanderSession(
            this.options.database,
            projectId,
            this.options.logger,
        );
        this.options.sendFullStateChange();
        return { projectId, sessionId };
    }
}

/**
 * The Commander's run state from durable rows alone; see {@link AgentCommanderService.status}. Shared with the
 * diagnostics snapshot, which must report it without owning the Commander service.
 */
export function commanderRunState(database: CaxriDatabase): CommanderRunState {
    const rows = agentCommanderTerminal(database);
    const terminal = rows && database.getTerminal(rows.terminalId);
    if (!rows || !terminal) return 'stopped';
    const shell = terminal.lastProcessState;
    if (shell !== 'starting' && shell !== 'running') return 'stopped';
    const agent = terminal.lastAgentProcessState;
    if (shell === 'starting' || agent === 'starting') return 'starting';
    if (agent !== 'running') return 'stopped';
    const activity = database.getSession(rows.sessionId)?.lastActivityState;
    return (activity && LIVE_ACTIVITY_STATES.get(activity)) ?? 'idle';
}

/**
 * Creates an empty Session without moving the Workbench selection and records it as the Commander's. The Commander
 * Terminal must exist: the record is what later admits delegation into the Session. At capacity it refuses rather than
 * dropping the oldest record, which would silently disown a Session that may still run a task. The caller announces the
 * change.
 */
export function createCommanderSession(
    database: CaxriDatabase,
    projectId: string,
    logger?: StructuredLogger,
    title?: string,
): string {
    const project = database.listVisibleProjects().find((candidate) => candidate.id === projectId);
    if (!project || !isTopLevelProject(project))
        throw new CaxriError('NOT_FOUND', 'Project is unavailable to the Agent Commander');
    const rows = database.agentCommanderRows();
    if (!rows) throw new CaxriError('UNAVAILABLE', 'Agent Commander is not running');
    if (rows.sessionIds.length >= MAX_COMMANDER_SESSIONS)
        throw new CaxriError(
            'CAPACITY',
            `Agent Commander already owns ${MAX_COMMANDER_SESSIONS} Sessions; delete finished ones to create more`,
        );
    const { session } = database.createSession(projectId, null, undefined, {
        selection: 'preserve',
    });
    /**
     * A manual title: the Agent has not started, so there is no native session to rename, and automatic naming would
     * only replace the Commander's subject with a name taken from the task-file pointer.
     */
    if (title) database.renameSession(session.id, title);
    database.setAppState('agentCommander', {
        projectId: rows.projectId,
        sessionId: rows.sessionId,
        ...(rows.terminalId && { terminalId: rows.terminalId }),
        sessionIds: [...rows.sessionIds, session.id],
    });
    logger?.write('info', logEventCatalog.agentCommander.sessionCreated, {
        fields: { projectId, sessionId: session.id, ownedCount: rows.sessionIds.length + 1 },
    });
    return session.id;
}

/**
 * Refuses a Session the Commander did not create, before `commander.session.archive` parks it. The Commander's own
 * hidden Session is not in that record either, so it can never archive itself. `NOT_FOUND` rather than `FORBIDDEN`,
 * matching how the Commander's other Session-scoped requests treat a Session outside its reach.
 *
 * The ownership record alone is not enough: a hand-over writes the same `sessionIds` list, and a Session the user
 * handed over is still the user's Session. The Commander may work in it, but archiving it would take the Session out of
 * the user's Workbench, so any Session with a hand-over record is refused too.
 */
export function requireCommanderSession(database: CaxriDatabase, sessionId: string): void {
    if (
        !database.agentCommanderRows()?.sessionIds.includes(sessionId) ||
        commanderHandovers(database).some((handover) => handover.sessionId === sessionId)
    )
        throw new CaxriError('NOT_FOUND', 'Session was not created by the Agent Commander');
}

/**
 * Removes a Commander Session that never received a Terminal, such as one created for a delegation that was refused
 * before it launched. Metadata only: a Session never owns user files. A Session that meanwhile gained a Terminal is
 * kept; `onDiscarded` announces an actual removal.
 */
export function discardCommanderSession(
    database: CaxriDatabase,
    sessionId: string,
    logger?: StructuredLogger,
    onDiscarded?: () => void,
): void {
    if (!database.agentCommanderRows()?.sessionIds.includes(sessionId)) return;
    if (database.listTerminals(sessionId).length > 0) return;
    database.deleteSession(sessionId);
    logger?.write('info', logEventCatalog.agentCommander.sessionDiscarded, {
        fields: { sessionId },
    });
    onDiscarded?.();
}
