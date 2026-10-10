import { randomUUID } from 'node:crypto';

import type {
    AgentChatFailureReason,
    AgentChatMessageInput,
    AgentChatPatchOperation,
    AgentChatSnapshot,
    AgentChatTaskSnapshot,
    AgentProvider,
    TerminalRecord,
} from '@caxri/protocol';
import {
    agentChatSnapshotSchema,
    agentChatTaskSnapshotSchema,
    agentProviderCatalog,
    CaxriError,
    errorMessage,
} from '@caxri/protocol';
import { assertE2EAgentChatInput, logEventCatalog, readE2EAgentPolicy } from '@caxri/system';

import { AgentRunAutonomy } from '../agent-run-autonomy';
import type { AgentLifecycleSignal } from '../agents';
import { SingleFlight } from '../single-flight';
import { agentChatDrivers } from './chat-drivers';
import { isAgentChatCommandListed } from './chat-items';
import {
    chatStartFailure,
    logChatProcessExited,
    prepareChatLaunch,
    readChatTranscript,
    requireChatTerminal,
    TERMINAL_FAILURE_REASONS,
} from './chat-launch';
import { ChatProjection } from './chat-projection';
import type {
    AgentChatExit,
    AgentChatProviderSession,
    AgentChatResponse,
    ChatInputDelivery,
    ChatLifecycleEvent,
} from './chat-provider';
import { AgentChatStartError } from './chat-provider';
import { ChatFollowUpQueue } from './chat-queue';
import { forgetTaskRevisions } from './chat-task-projections';
import { ChatTaskList } from './chat-tasks';
import type { AgentChatServiceOptions } from './service-options';

interface ChatState {
    projection: ChatProjection;
    session?: AgentChatProviderSession;
    launchId?: string;
    /**
     * Settles after the last accepted send. Serializes sends so two quick messages cannot both start a turn.
     */
    sendQueue: Promise<unknown>;
    followUps: ChatFollowUpQueue;
}

/**
 * Owns every Chat Terminal's provider process and in-memory conversation projection. Processes start lazily on the
 * first read or message, so Server Core restart never relaunches idle Chats; the provider's own record is the source of
 * truth and comes back on resume. See `docs/agent-chat.md`.
 */
export class AgentChatService {
    private readonly states = new Map<string, ChatState>();
    /**
     * One provider start in flight per Terminal; concurrent reads and sends join it.
     */
    private readonly starts = new SingleFlight<string, void>();

    /**
     * The revision a Chat's next projection starts from after its state was dropped (restart, close). Clients keep
     * their cached snapshot across both, so a projection that restarted at 0 would have every new patch discarded as
     * already applied. Starting one past the last revision instead leaves a gap that makes each Client re-read.
     */
    private readonly revisionFloors = new Map<string, number>();

    /**
     * The same revision floor for task projections, keyed by Terminal and task.
     */
    private readonly taskRevisionFloors = new Map<string, number>();

    private readonly agentRunAutonomy = new AgentRunAutonomy();

    private isShuttingDown = false;

    constructor(private readonly options: AgentChatServiceOptions) {}

    private async stop(terminalId: string): Promise<void> {
        const state = this.states.get(terminalId);
        if (!state) return;
        await Promise.allSettled([this.starts.get(terminalId)]);
        await state.session?.close();
        state.session = undefined;
    }

    private state(terminalId: string): ChatState {
        const existing = this.states.get(terminalId);
        if (existing) return existing;
        const state: ChatState = {
            projection: new ChatProjection({
                terminalId,
                revision: this.revisionFloors.get(terminalId) ?? 0,
                taskRevisionFloors: this.taskRevisionFloors,
                logger: this.options.logger,
                send: (event) => this.options.send(event),
                onChange: () => state.followUps.dispatch(),
            }),
            sendQueue: Promise.resolve(),
            followUps: new ChatFollowUpQueue({
                terminalId,
                logger: this.options.logger,
                read: () => state.projection.snapshot,
                apply: (operations) => this.apply(terminalId, operations),
                canDeliver: () =>
                    this.states.get(terminalId) === state && state.session?.isOpen === true,
                enqueue: (deliver) => this.enqueue(terminalId, deliver),
            }),
        };
        this.states.set(terminalId, state);
        return state;
    }

    private apply(terminalId: string, operations: AgentChatPatchOperation[]): void {
        this.states.get(terminalId)?.projection.apply(operations);
    }

    /**
     * Drops a Chat's projection without letting its pending patches reach Clients after a replacement chain began.
     */
    private forget(terminalId: string): void {
        const state = this.states.get(terminalId);
        if (!state) return;
        this.revisionFloors.set(terminalId, state.projection.retire());
        this.states.delete(terminalId);
    }

    private setStatus(
        terminalId: string,
        status: AgentChatSnapshot['status'],
        failure?: { reason: AgentChatFailureReason; detail?: string },
    ): void {
        this.apply(terminalId, [{ op: 'state', state: { status, failure: failure ?? null } }]);
    }

    private sendTerminalChange(terminalId: string): void {
        this.options.send({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: [terminalId] },
        });
    }

    private async ensureStarted(
        terminal: TerminalRecord & { provider: AgentProvider },
        shouldKeepAgentAutonomy = false,
    ): Promise<AgentChatProviderSession> {
        const state = this.state(terminal.id);
        /**
         * `start()` publishes its session as soon as the process spawns, before the thread exists, so an open session
         * alone does not mean it can take a turn. Join an in-flight start instead of sending into it early.
         */
        if (this.starts.has(terminal.id) || !state.session?.isOpen)
            await this.starts.run(terminal.id, () =>
                this.start(terminal, state, shouldKeepAgentAutonomy),
            );
        if (!state.session?.isOpen)
            throw new CaxriError(
                'UNAVAILABLE',
                state.projection.snapshot.failure?.detail ??
                    `${agentProviderCatalog[terminal.provider].displayName} Chat is not running`,
            );
        return state.session;
    }

    /**
     * Starts the provider for a caller that does not need the session. A failed start is already recorded in the
     * projection, where every Client sees it.
     */
    private async startQuietly(
        terminal: TerminalRecord & { provider: AgentProvider },
        shouldKeepAgentAutonomy = false,
    ): Promise<void> {
        try {
            await this.ensureStarted(terminal, shouldKeepAgentAutonomy);
        } catch {
            // Recorded in the projection by start().
        }
    }

    private async start(
        terminal: TerminalRecord & { provider: AgentProvider },
        state: ChatState,
        shouldKeepAgentAutonomy: boolean,
    ): Promise<void> {
        const { database, logger } = this.options;
        const terminalId = terminal.id;
        const { provider } = terminal;
        const launchId = randomUUID();
        const startedAt = Date.now();
        state.launchId = launchId;
        this.setStatus(terminalId, 'starting');
        database.updateTerminalState(terminalId, 'starting');
        database.updateAgentProcessState(terminalId, 'starting');
        this.sendTerminalChange(terminalId);
        this.options.coordinator.beginTerminalLaunch(terminalId, launchId);
        const isCurrent = () =>
            state.launchId === launchId && this.states.get(terminalId) === state;
        let session: AgentChatProviderSession | undefined;
        try {
            const driver = agentChatDrivers[provider];
            if (!driver) throw new AgentChatStartError('spawn_failed');
            const launch = this.agentRunAutonomy.launch(
                terminalId,
                provider,
                this.options.launchSettings(provider),
                shouldKeepAgentAutonomy,
            );
            const { executable, environment, isRealAgentE2E } = await prepareChatLaunch(
                this.options,
                provider,
                launch,
            );
            session = driver.create({
                terminalId,
                cwd: terminal.cwd,
                executable,
                environment,
                launch,
                isRealAgentE2E,
                agentSessionId: database.getTerminal(terminalId)?.agentSessionId,
                clientVersion: this.options.clientVersion,
                spawnProcess: this.options.spawnProcess,
                read: () => state.projection.snapshot,
                apply: (operations) => {
                    if (isCurrent()) this.apply(terminalId, operations);
                },
                applyTask: (taskId, operations) => {
                    if (isCurrent()) state.projection.applyTask(taskId, operations);
                },
                readTask: (taskId) => state.projection.tasks.get(taskId),
                lifecycle: (event) => {
                    if (isCurrent()) this.lifecycle(terminalId, provider, launchId, event);
                },
                onSessionBound: (agentSessionId) => {
                    if (!isCurrent()) return;
                    if (database.rebindAgentSession(terminalId, provider, agentSessionId))
                        this.sendTerminalChange(terminalId);
                },
                onTurnFinished: (status, durationMs) =>
                    logger.write('info', logEventCatalog.agentChat.turnFinished, {
                        fields: { terminalId, status, durationMs: durationMs ?? null },
                    }),
                onProtocolRejected: (reason, method) =>
                    logger.write('warn', logEventCatalog.agentChat.protocolRejected, {
                        fields: { terminalId, reason, method: method.slice(0, 100) },
                    }),
                onExit: (exit) => this.onExit(terminalId, provider, state, launchId, exit),
                readTranscript: () => readChatTranscript(this.options, terminalId),
            });
            state.session = session;
            const mode = await session.start();
            if (!isCurrent()) {
                await session.close();
                return;
            }
            this.setStatus(terminalId, 'ready');
            database.updateTerminalState(terminalId, 'running');
            database.updateAgentProcessState(terminalId, 'running');
            this.sendTerminalChange(terminalId);
            if (database.getTerminal(terminalId)?.agentSessionId)
                this.options.coordinator.probeTerminal(terminalId);
            logger.write('info', logEventCatalog.agentChat.processStarted, {
                fields: { terminalId, outcome: 'ready', mode, durationMs: Date.now() - startedAt },
            });
        } catch (error) {
            if (state.session === session) state.session = undefined;
            await session?.close();
            const failure = chatStartFailure(this.options, terminal, error, startedAt);
            if (isCurrent() && !this.isShuttingDown) this.recordStartFailure(terminalId, failure);
        }
    }

    private recordStartFailure(
        terminalId: string,
        failure: { reason: AgentChatFailureReason; detail?: string },
    ): void {
        const { database } = this.options;
        this.setStatus(terminalId, 'failed', failure);
        this.options.coordinator.endTerminalLaunch(terminalId);
        if (!database.getTerminal(terminalId)) return;
        database.updateTerminalState(
            terminalId,
            'failed',
            TERMINAL_FAILURE_REASONS[failure.reason],
            failure.detail,
        );
        database.updateAgentProcessState(terminalId, 'failed');
        this.sendTerminalChange(terminalId);
    }

    private lifecycle(
        terminalId: string,
        provider: AgentProvider,
        launchId: string,
        event: ChatLifecycleEvent,
    ): void {
        const signal: AgentLifecycleSignal = { ...event, launchId, provider, terminalId };
        // eslint-disable-next-line no-void -- lifecycle delivery is ordered by the coordinator, not by this caller.
        void this.observeLifecycleSignal(signal);
    }

    private async observeLifecycleSignal(signal: AgentLifecycleSignal): Promise<void> {
        try {
            await this.options.observeLifecycleSignal(signal);
        } catch (error: unknown) {
            this.options.logger.write('warn', logEventCatalog.agentChat.protocolRejected, {
                fields: {
                    terminalId: signal.terminalId,
                    reason: 'lifecycleFailed',
                    error: errorMessage(error, 'unknown'),
                },
            });
        }
    }

    private onExit(
        terminalId: string,
        provider: AgentProvider,
        state: ChatState,
        launchId: string,
        exit: AgentChatExit,
    ): void {
        const { database } = this.options;
        logChatProcessExited(this.options, terminalId, exit);
        // A start in progress reports its own closed failure reason.
        if (state.launchId !== launchId || this.isShuttingDown || this.starts.has(terminalId))
            return;
        /**
         * The projection already marked the running turn interrupted; end it for Session Activity too. A requested stop
         * (Restart, close) ends the turn the way an interrupt does; an unrequested one is a provider failure.
         */
        if (exit.activeTurnId)
            this.lifecycle(
                terminalId,
                provider,
                launchId,
                exit.requested
                    ? { phase: 'turnFinished', agentTurnId: exit.activeTurnId }
                    : {
                          phase: 'turnFailed',
                          agentTurnId: exit.activeTurnId,
                          agentFailure: 'provider_failed',
                      },
            );
        state.session = undefined;
        state.launchId = undefined;
        // Background work lives inside the provider process and ended with it.
        new ChatTaskList({
            read: () => state.projection.snapshot,
            apply: (operations) => this.apply(terminalId, operations),
        }).stopAll();
        this.options.coordinator.endTerminalLaunch(terminalId);
        if (!database.getTerminal(terminalId)) return;
        if (exit.requested) {
            this.setStatus(terminalId, 'stopped');
            database.updateTerminalState(terminalId, 'stopped');
            database.updateAgentProcessState(terminalId, 'stopped');
        } else {
            // No detail: the closed reason's own copy already says everything Caxri knows about the exit.
            this.setStatus(terminalId, 'failed', { reason: 'process_exited' });
            database.updateTerminalExitState(terminalId, 'dead');
            database.updateAgentProcessExitState(terminalId, 'dead');
        }
        this.sendTerminalChange(terminalId);
    }

    /**
     * Serializes input per Chat, starting the provider first, so messages and commands reach it in the order sent.
     */
    private async enqueue(terminalId: string, deliver: ChatInputDelivery): Promise<void> {
        const terminal = requireChatTerminal(this.options.database, terminalId);
        const state = this.state(terminalId);
        const previous = state.sendQueue;
        const run = (async () => {
            await previous;
            await deliver(await this.ensureStarted(terminal));
        })();
        state.sendQueue = Promise.allSettled([run]);
        await run;
    }

    /**
     * Number of live provider processes, optionally limited to one Session. Counted as running work so Server Core idle
     * exit, the window-close confirmation, and Session deletion prompts treat a running Chat like a running PTY.
     */
    liveCount(sessionId?: string): number {
        let count = 0;
        for (const [terminalId, state] of this.states) {
            if (!state.session?.isOpen) continue;
            if (
                sessionId !== undefined &&
                this.options.database.getTerminal(terminalId)?.sessionId !== sessionId
            )
                continue;
            count += 1;
        }
        return count;
    }

    /**
     * Whether a live Chat is inside a turn, which `terminal.switchSurface` asks before ending.
     */
    hasActiveTurn(terminalId: string): boolean {
        const state = this.states.get(terminalId);
        return Boolean(state?.session?.isOpen && state.projection.snapshot.activeTurnId);
    }

    read(terminalId: string): AgentChatSnapshot {
        const terminal = requireChatTerminal(this.options.database, terminalId);
        const state = this.state(terminalId);
        state.projection.flush();
        if (
            !state.session &&
            !this.starts.has(terminalId) &&
            state.projection.snapshot.status !== 'failed'
        )
            // eslint-disable-next-line no-void -- the read returns the starting projection; patches follow.
            void this.startQuietly(terminal);
        state.projection.flush();
        return agentChatSnapshotSchema.parse(state.projection.snapshot);
    }

    /**
     * Sends a message. While a turn runs it steers that turn when asked to, and otherwise waits in the queue; a message
     * also waits behind earlier queued ones so the queue keeps its order.
     */
    async send(
        terminalId: string,
        message: Omit<AgentChatMessageInput, 'delivery'>,
        delivery: 'queue' | 'steer' = 'queue',
    ): Promise<void> {
        assertE2EAgentChatInput(readE2EAgentPolicy(), message.text);
        await this.enqueue(terminalId, async (session) => {
            const state = this.state(terminalId);
            if (delivery === 'steer' && state.projection.snapshot.activeTurnId) {
                await session.send(message, { delivery: 'steered' });
                state.followUps.logSteered();
                return;
            }
            if (state.followUps.mustWait()) {
                state.followUps.add({ id: randomUUID(), kind: 'message', message });
                return;
            }
            await session.send(message);
        });
    }

    async runCommand(terminalId: string, name: string, arguments_?: string): Promise<void> {
        assertE2EAgentChatInput(readE2EAgentPolicy(), `/${name}`);
        await this.enqueue(terminalId, async (session) => {
            const state = this.state(terminalId);
            if (!isAgentChatCommandListed(state.projection.snapshot, name))
                throw new CaxriError('VALIDATION', `/${name} is not available in this Chat`);
            const trimmed = arguments_?.trim() ? arguments_ : undefined;
            if (state.followUps.mustWait()) {
                state.followUps.add({
                    id: randomUUID(),
                    kind: 'command',
                    name,
                    ...(trimmed !== undefined && { arguments: trimmed }),
                });
                return;
            }
            await session.runCommand(name, trimmed);
        });
    }

    /**
     * Stops the running turn. Queued messages stay and the queue pauses, so stopping a turn never fires the next
     * message by surprise. Background tasks keep running.
     */
    async interrupt(terminalId: string): Promise<void> {
        requireChatTerminal(this.options.database, terminalId);
        const state = this.states.get(terminalId);
        if (!state) return;
        state.followUps.pause();
        await state.session?.interrupt();
    }

    /**
     * Returns a task's own projection: the live one, or one rebuilt from the provider's record for a task this process
     * never saw (a resumed conversation, an evicted projection).
     */
    async readTask(terminalId: string, taskId: string): Promise<AgentChatTaskSnapshot> {
        const terminal = requireChatTerminal(this.options.database, terminalId);
        const state = this.state(terminalId);
        state.projection.flush();
        const live = state.projection.tasks.resolve(taskId);
        if (live) return agentChatTaskSnapshotSchema.parse(live);
        let session: AgentChatProviderSession;
        try {
            session = await this.ensureStarted(terminal);
        } catch {
            throw new CaxriError('NOT_FOUND', 'This task is no longer available');
        }
        const history = await session.readTaskHistory(taskId);
        const current = this.states.get(terminalId);
        if (!history || current !== state)
            throw new CaxriError('NOT_FOUND', 'This task is no longer available');
        return agentChatTaskSnapshotSchema.parse(state.projection.tasks.install(history));
    }

    async stopTask(terminalId: string, taskId: string): Promise<void> {
        requireChatTerminal(this.options.database, terminalId);
        const state = this.states.get(terminalId);
        const task = state?.projection.snapshot.tasks?.find(
            (candidate) => candidate.id === taskId || candidate.itemId === taskId,
        );
        if (!state?.session?.isOpen || task?.status !== 'running' || !task.canStop)
            throw new CaxriError('CONFLICT', 'This task is no longer running');
        await state.session.stopTask(task.id);
    }

    removeQueued(terminalId: string, id: string): void {
        requireChatTerminal(this.options.database, terminalId);
        const state = this.states.get(terminalId);
        if (!state) throw new CaxriError('CONFLICT', 'This message is no longer queued');
        state.followUps.remove(id, 'removed');
    }

    /**
     * Sends one queued message ahead of the rest: it steers the running turn, or starts a turn when the Chat is idle.
     */
    async sendQueuedNow(terminalId: string, id: string): Promise<void> {
        await this.enqueue(terminalId, async (session) => {
            const state = this.state(terminalId);
            const entry = state.followUps.entry(id);
            const isSteering = Boolean(state.projection.snapshot.activeTurnId);
            if (isSteering && entry.kind === 'command')
                throw new CaxriError('CONFLICT', 'A command cannot join a running turn');
            await state.followUps.sendNow(session, id, isSteering ? 'steered' : 'queued');
        });
    }

    resumeQueue(terminalId: string): void {
        requireChatTerminal(this.options.database, terminalId);
        this.states.get(terminalId)?.followUps.resume();
    }

    respond(terminalId: string, requestId: string, response: AgentChatResponse): void {
        requireChatTerminal(this.options.database, terminalId);
        const session = this.states.get(terminalId)?.session;
        if (!session) throw new CaxriError('CONFLICT', 'This request is no longer pending');
        session.respond(requestId, response);
    }

    /**
     * Stops the provider and starts it again on the same Agent Session. Clears a previous failure. A resume keeps the
     * replaced start's approval mode (see `AgentRunAutonomy`).
     */
    async restart(terminalId: string, shouldKeepAgentAutonomy = false): Promise<TerminalRecord> {
        const terminal = requireChatTerminal(this.options.database, terminalId);
        await this.stop(terminalId);
        const previous = this.states.get(terminalId);
        this.forget(terminalId);
        if (previous) this.state(terminalId).followUps.adopt(previous.followUps);
        await this.startQuietly(terminal, shouldKeepAgentAutonomy);
        return this.options.database.getTerminal(terminalId) ?? terminal;
    }

    /**
     * Stops a Chat whose Terminal is being closed, deleted, or archived, and forgets its projection.
     */
    async close(terminalId: string): Promise<void> {
        await this.stop(terminalId);
        this.forget(terminalId);
        forgetTaskRevisions(this.taskRevisionFloors, terminalId);
    }

    async closeSession(sessionId: string): Promise<void> {
        const ids = this.options.database
            .listTerminals(sessionId)
            .filter((terminal) => this.states.has(terminal.id))
            .map((terminal) => terminal.id);
        await Promise.all(ids.map((id) => this.close(id)));
    }

    /**
     * Server Core shutdown. Durable process state is stamped by the shared shutdown path, so exits here write nothing.
     */
    async shutdown(): Promise<void> {
        this.isShuttingDown = true;
        await Promise.all(this.states.keys().map((id) => this.stop(id)));
        for (const state of this.states.values()) state.projection.retire();
        this.states.clear();
    }
}
