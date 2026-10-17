import type {
    BootstrapState,
    CommanderAgent,
    CommanderBoard,
    CommanderClearData,
    CommanderClearDataResult,
    CommanderDataSummary,
    CommanderIdentity,
    CommanderRunState,
    CommanderSnapshot,
    SessionPullRequests,
    TerminalKind,
    TerminalRecord,
} from '@caxri/protocol';
import { CaxriError, DEFAULT_COMMANDER_AGENT, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import { agentCommanderTerminal } from '../db';
import { commanderBoard } from './board';
import { clearCommanderStores, commanderAgent, readCommanderData } from './data';
import type { CommanderHandoverService } from './handover';
import { commanderHandovers } from './handover-records';
import type { CommanderInboxService } from './inbox';
import { createCommanderSession } from './sessions';
import { CommanderTaskLedger } from './tasks';
import { prepareCommanderWorkspace } from './workspace';

export interface AgentCommanderServiceOptions {
    /**
     * Drops a queued Commander restore and resolves once one already spawning has finished, so a stop always acts on
     * the process that restore produced instead of racing its spawn.
     */
    cancelRestore(sessionId: string): Promise<void>;
    database: CaxriDatabase;
    /**
     * The Commander Inbox, which Clear Commander Data counts and empties.
     */
    inbox: Pick<CommanderInboxService, 'clear' | 'counts'>;
    /**
     * Manual hand-overs retain ownership provenance after Clear Commander Data deletes their continuation tasks.
     */
    handovers: Pick<CommanderHandoverService, 'forgetClearedTasks' | 'returnAllForStop'>;
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
    /**
     * Readies the machine for launching `agent` in the workspace before its process starts, such as marking the folder
     * trusted for Claude Code. Never throws: an unprepared launch still starts and shows the Agent's own prompt.
     */
    prepareLaunch?(agent: CommanderAgent, workspacePath: string): Promise<void>;
    probeTerminal(terminalId: string): void;
    pullRequests(): SessionPullRequests;
    /**
     * Relaunches the Commander Terminal on a new conversation with its current provider, through the same path as a
     * Workbench Terminal's fresh restart.
     */
    relaunchFresh(terminalId: string): Promise<unknown>;
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
     * Agent conversation for the next `restoreTerminals`. Resolves without effect when no process is live.
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
    /**
     * The latest switch or conversation reset. Each one waits for the one before it and for any ensure or stop in
     * flight, and ensure and stop wait for it, so the Commander process is never replaced twice at once.
     */
    private replacing: Promise<unknown> | undefined;
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
            const launching = rows;
            const agent = database.getAppState('commanderAgent') ?? DEFAULT_COMMANDER_AGENT;
            await this.options.prepareLaunch?.(agent, workspacePath);
            this.options.onLaunching?.();
            const terminal = await this.options.createAndStartTerminal(
                launching.sessionId,
                agent,
                workspacePath,
                /**
                 * Re-reads the rows instead of writing back the ones captured above: Terminal creation awaits, and a
                 * hand-over or take-back accepted meanwhile must keep its change to `sessionIds`.
                 */
                (created) => {
                    const current = database.agentCommanderRows() ?? launching;
                    database.setAppState('agentCommander', {
                        projectId: current.projectId,
                        sessionId: current.sessionId,
                        terminalId: created.id,
                        sessionIds: [...current.sessionIds],
                    });
                },
            );
            this.options.probeTerminal(terminal.id);
            this.logEnsured('created', terminal.id, startedAt);
        } else {
            const terminal = database.getTerminal(rows.terminalId);
            const state = terminal?.lastProcessState;
            const isRunning = state === 'running' || state === 'starting';
            if (!isRunning) {
                await this.options.prepareLaunch?.(commanderAgent(database), workspacePath);
                this.options.onLaunching?.();
            }
            this.options.restoreTerminals(rows.sessionId);
            this.logEnsured(isRunning ? 'running' : 'restored', rows.terminalId, startedAt, state);
        }
        return this.requireSnapshot();
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
         * A stop racing the first ensure waits for the Terminal it creates, and one racing a switch waits for the
         * process the switch launches, so the stop is never silently lost.
         */
        await settled(this.replacing);
        await settled(this.ensuring);
        const rows = this.options.database.agentCommanderRows();
        if (!rows?.terminalId) {
            await this.options.handovers.returnAllForStop();
            this.options.logger?.write('info', logEventCatalog.agentCommander.stopped, {
                fields: { outcome: 'not_running' },
            });
            return;
        }
        const startedAt = performance.now();
        await this.options.cancelRestore(rows.sessionId);
        await this.options.stopTerminal(rows.terminalId);
        this.options.onStopped?.();
        await this.options.handovers.returnAllForStop();
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
     * Runs `work` after every ensure, stop, and earlier replacement in flight has settled, and makes ensure and stop
     * wait for it in turn. A failure belongs to this caller alone; the next replacement still runs.
     *
     * What it waits for is read on arrival. A stop that arrives later waits for this replacement, so reading
     * `this.stopping` only after an earlier replacement settled would make the two wait on each other forever.
     */
    private async replace<T>(work: () => Promise<T>): Promise<T> {
        const inFlight = [this.replacing, this.stopping, this.ensuring];
        const pending = (async () => {
            await Promise.all(inFlight.map((operation) => settled(operation)));
            return work();
        })();
        this.replacing = pending;
        try {
            return await pending;
        } finally {
            if (this.replacing === pending) this.replacing = undefined;
        }
    }

    /**
     * Stops the Commander process and relaunches its Terminal on a new conversation, optionally with another provider
     * first. The Terminal row and its ID stay, so every task the Commander delegated before still reports to it.
     */
    private async relaunchOnNewConversation(
        rows: { sessionId: string; terminalId: string },
        workspacePath: string,
        agent: CommanderAgent,
        shouldChangeProvider: boolean,
    ): Promise<void> {
        const { database } = this.options;
        await this.options.prepareLaunch?.(agent, workspacePath);
        await this.options.cancelRestore(rows.sessionId);
        await this.options.stopTerminal(rows.terminalId);
        /**
         * The previous conversation is over on purpose, so the turn it was in is not offered for resumption.
         */
        this.options.onStopped?.();
        if (
            shouldChangeProvider &&
            !database.terminalSurfaces.replaceAgentProvider(rows.terminalId, agent)
        )
            throw new CaxriError(
                'CONFLICT',
                'The Agent Commander Terminal changed while switching',
            );
        this.options.onLaunching?.();
        await this.options.relaunchFresh(rows.terminalId);
        this.options.probeTerminal(rows.terminalId);
        this.options.sendTerminalChange(rows.terminalId);
    }

    private requireSnapshot(): CommanderSnapshot {
        const snapshot = this.snapshot();
        if (!snapshot) throw new CaxriError('UNAVAILABLE', 'Agent Commander failed to start');
        return snapshot;
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
        if (this.stopping) await settled(this.stopping);
        /**
         * A reopen during a switch or a conversation reset returns the Commander that replacement launched.
         */
        if (this.replacing) await settled(this.replacing);
        const pending = (this.ensuring ??= this.runEnsure());
        try {
            return await pending;
        } finally {
            if (this.ensuring === pending) this.ensuring = undefined;
        }
    }

    /**
     * Explicit Stop returns every manually handed-over Session, even when the Commander is already stopped. Running
     * Agents, task records, and Commander-created Sessions remain.
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
     * Moves the Commander to another Agent CLI on a new conversation. Its memory, task ledger, Inbox, and delegated
     * Sessions carry over: they live in Caxri and the workspace, not in the conversation. Without a Commander Terminal
     * the choice is stored and the next start uses it.
     */
    switchAgent(agent: CommanderAgent): Promise<CommanderSnapshot> {
        return this.replace(async () => {
            const { database } = this.options;
            const startedAt = performance.now();
            const from = commanderAgent(database);
            database.setAppState('commanderAgent', agent);
            const identity = agentCommanderTerminal(database);
            const workspacePath = identity && database.getProject(identity.projectId)?.rootPath;
            let outcome: 'stored' | 'switched' | 'unchanged' = 'stored';
            if (identity && workspacePath) {
                outcome = from === agent ? 'unchanged' : 'switched';
                if (outcome === 'switched')
                    await this.relaunchOnNewConversation(identity, workspacePath, agent, true);
            }
            this.options.logger?.write('info', logEventCatalog.agentCommander.agentSwitched, {
                fields: {
                    outcome,
                    from,
                    to: agent,
                    durationMs: Math.round(performance.now() - startedAt),
                },
            });
            return outcome === 'stored' ? this.runEnsure() : this.requireSnapshot();
        });
    }

    data(): Promise<CommanderDataSummary> {
        return readCommanderData(this.options);
    }

    /**
     * Clears what the request names; see `commanderClearDataSchema`. Reached only after Desktop Main's native
     * confirmation. Memory is reset before `AGENTS.md` is rewritten, so the rewrite embeds what remains.
     */
    clearData(request: CommanderClearData): Promise<CommanderClearDataResult> {
        return this.replace(async () => {
            const { database } = this.options;
            const startedAt = performance.now();
            const taskScope =
                request.tasks === undefined
                    ? null
                    : typeof request.tasks === 'string'
                      ? request.tasks
                      : 'selected';
            let stage: 'stores' | 'instructions' | 'conversation' = 'stores';
            let tasksDeleted = 0;
            let handoversForgotten = 0;
            try {
                const { handoversForgotten: forgotten, ...cleared } = await clearCommanderStores(
                    this.options,
                    request,
                );
                tasksDeleted = cleared.tasksDeleted;
                handoversForgotten = forgotten;
                stage = 'instructions';
                const instructionsRewritten = request.instructions === true || cleared.memoryReset;
                if (instructionsRewritten)
                    await prepareCommanderWorkspace(this.options.userDataPath);
                const identity = agentCommanderTerminal(database);
                const workspacePath = identity && database.getProject(identity.projectId)?.rootPath;
                let isConversationReset = false;
                if (identity && workspacePath && request.conversation) {
                    stage = 'conversation';
                    await this.relaunchOnNewConversation(
                        identity,
                        workspacePath,
                        commanderAgent(database),
                        false,
                    );
                    isConversationReset = true;
                }
                const result = {
                    ...cleared,
                    instructionsRewritten,
                    conversationReset: isConversationReset,
                };
                this.options.logger?.write('info', logEventCatalog.agentCommander.dataCleared, {
                    fields: {
                        outcome: 'cleared',
                        ...result,
                        handoversForgotten,
                        taskScope,
                        durationMs: Math.round(performance.now() - startedAt),
                    },
                });
                return result;
            } catch (error) {
                this.options.logger?.write('warn', logEventCatalog.agentCommander.dataCleared, {
                    fields: {
                        outcome: 'failed',
                        failedStage: stage,
                        tasksDeleted,
                        handoversForgotten,
                        taskScope,
                        durationMs: Math.round(performance.now() - startedAt),
                    },
                });
                throw error;
            } finally {
                /**
                 * Also after a failure: tasks already deleted, or a Commander the failed restart left stopped, must not
                 * stay on screen as they were.
                 */
                if (stage === 'conversation' || tasksDeleted > 0)
                    this.options.sendFullStateChange();
            }
        });
    }

    /**
     * Reads durable rows only, so it is safe to poll and never starts anything. The Commander is an Agent CLI inside a
     * Shell PTY, and the Agent can exit while the Shell lives on, so both processes must be live. Without them it is
     * `stopped` whatever its Session last reported: a turn cut off by a stop or a quit leaves `running` behind.
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
 * Waits for `pending` without adopting its failure, which belongs to that operation's own caller.
 */
async function settled(pending: Promise<unknown> | undefined): Promise<void> {
    try {
        await pending;
    } catch {
        // Reported to the caller that started it.
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
