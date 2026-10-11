import { randomUUID } from 'node:crypto';

import type {
    AgentChatMessageInput,
    AgentChatModelRequest,
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
    resolveAgentChatModelChange,
} from '@caxri/protocol';
import { assertE2EAgentChatInput, logEventCatalog, readE2EAgentPolicy } from '@caxri/system';

import { AgentRunAutonomy } from '../agents';
import { SingleFlight } from '../single-flight';
import { agentChatDrivers } from './chat-drivers';
import { ChatEndpointLease } from './chat-endpoint-lease';
import { isAgentChatCommandListed } from './chat-items';
import {
    chatStartFailure,
    didPersistChatStartFailure,
    forwardChatLifecycle,
    logChatProcessExited,
    prepareChatLaunch,
    readChatTranscript,
    requireChatTerminal,
} from './chat-launch';
import type { AgentChatExit, AgentChatProviderSession, AgentChatResponse } from './chat-provider';
import { AgentChatStartError } from './chat-provider';
import { chatSessionLogCallbacks } from './chat-session-logs';
import type { ChatState, ChatStateDelivery, ChatTerminal } from './chat-states';
import { ChatStates } from './chat-states';
import { ChatTaskList } from './chat-tasks';
import type { AgentChatServiceOptions } from './service-options';

/**
 * Owns every Chat Terminal's provider process and in-memory conversation projection. Processes start lazily on the
 * first read or message, so Server Core restart never relaunches idle Chats; the provider's own record is the source of
 * truth and comes back on resume. See `docs/agent-chat.md`.
 */
export class AgentChatService {
    private readonly states: ChatStates;
    /**
     * One provider start in flight per Terminal; concurrent reads and sends join it.
     */
    private readonly starts = new SingleFlight<string, void>();

    private readonly agentRunAutonomy = new AgentRunAutonomy();

    private readonly endpoint: ChatEndpointLease;

    private isShuttingDown = false;

    constructor(private readonly options: AgentChatServiceOptions) {
        this.endpoint = new ChatEndpointLease(options);
        this.states = new ChatStates({
            database: options.database,
            logger: options.logger,
            send: (event) => options.send(event),
            enqueue: (terminalId, state, deliver) => this.enqueueOn(terminalId, state, deliver),
        });
    }

    private async stop(terminalId: string): Promise<void> {
        const state = this.states.get(terminalId);
        if (!state) return;
        await Promise.allSettled([this.starts.get(terminalId)]);
        await state.session?.close();
        state.session = undefined;
    }

    private async ensureStarted(
        terminalId: string,
        state: ChatState,
        shouldKeepAgentAutonomy = false,
    ): Promise<AgentChatProviderSession> {
        const terminal = this.states.admit(terminalId, state);
        /**
         * `start()` publishes its session as soon as the process spawns, before the thread exists, so an open session
         * alone does not mean it can take a turn. Join an in-flight start instead of sending into it early.
         */
        if (this.starts.has(terminalId) || !state.session?.isOpen)
            await this.starts.run(terminalId, () =>
                this.start(terminal, state, shouldKeepAgentAutonomy),
            );
        // A teardown may have begun while the start was in flight; its session is about to close.
        this.states.admit(terminalId, state);
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
     * projection, where every Client sees it, and a refused admission (a detached or closing Chat) starts nothing.
     */
    private async startQuietly(
        terminalId: string,
        state: ChatState,
        shouldKeepAgentAutonomy = false,
    ): Promise<void> {
        try {
            await this.ensureStarted(terminalId, state, shouldKeepAgentAutonomy);
        } catch {
            // Recorded in the projection by start(), or refused before anything started.
        }
    }

    /**
     * Ends a start whose Chat began a teardown before its provider spawned. Nothing ran, so this is not a failure: the
     * Terminal records the stop a running provider's requested exit would have.
     */
    private abandonStart(
        terminalId: string,
        state: ChatState,
        launchId: string,
        startedAt: number,
    ): void {
        const { coordinator, database, logger } = this.options;
        if (state.launchId === launchId) state.launchId = undefined;
        this.endpoint.retire(terminalId);
        coordinator.endTerminalLaunch(terminalId);
        logger.write('info', logEventCatalog.agentChat.processStarted, {
            fields: {
                terminalId,
                outcome: 'abandoned',
                reason: state.retiring ?? 'closed',
                durationMs: Date.now() - startedAt,
            },
        });
        // Shutdown stamps durable state through the shared shutdown path.
        if (this.isShuttingDown || !database.getTerminal(terminalId)) return;
        this.states.recordRequestedStop(terminalId, state);
        this.states.publish(terminalId);
    }

    private async start(
        terminal: ChatTerminal,
        state: ChatState,
        shouldKeepAgentAutonomy: boolean,
    ): Promise<void> {
        const { database, logger } = this.options;
        const terminalId = terminal.id;
        const { provider } = terminal;
        const launchId = randomUUID();
        const startedAt = Date.now();
        state.launchId = launchId;
        this.states.setStatus(terminalId, 'starting');
        database.updateTerminalState(terminalId, 'starting');
        database.updateAgentProcessState(terminalId, 'starting');
        this.states.publish(terminalId);
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
            const prepared = await prepareChatLaunch(this.options, provider, launch, terminal.cwd);
            const { cwd, executable, isRealAgentE2E } = prepared;
            const environment = await this.endpoint.environment(
                terminal,
                launchId,
                prepared.environment,
            );
            // Preparing awaited; the Chat may have been closed, deleted, detached, or archived meanwhile.
            if (!this.states.isAdmitted(terminalId, state)) {
                this.abandonStart(terminalId, state, launchId, startedAt);
                return;
            }
            session = driver.create({
                terminalId,
                cwd,
                executable,
                environment,
                launch,
                isRealAgentE2E,
                agentSessionId: database.getTerminal(terminalId)?.agentSessionId,
                clientVersion: this.options.clientVersion,
                spawnProcess: this.options.spawnProcess,
                turnRequestTimeoutMs: this.options.turnRequestTimeoutMs,
                read: () => state.projection.snapshot,
                apply: (operations) => {
                    if (isCurrent()) this.states.apply(terminalId, operations);
                },
                applyTask: (taskId, operations) => {
                    if (isCurrent()) state.projection.applyTask(taskId, operations);
                },
                readTask: (taskId) => state.projection.tasks.get(taskId),
                lifecycle: (event) => {
                    if (isCurrent())
                        forwardChatLifecycle(this.options, {
                            ...event,
                            launchId,
                            provider,
                            terminalId,
                        });
                },
                onSessionBound: (agentSessionId) => {
                    if (!isCurrent()) return;
                    if (database.rebindAgentSession(terminalId, provider, agentSessionId))
                        this.states.publish(terminalId);
                },
                ...chatSessionLogCallbacks(this.options, terminalId),
                onExit: (exit) => this.onExit(terminalId, provider, state, launchId, exit),
                readTranscript: () => readChatTranscript(this.options, terminalId),
            });
            state.session = session;
            const mode = await session.start();
            if (!isCurrent()) {
                await session.close();
                return;
            }
            await this.endpoint.activate(terminalId);
            this.states.setStatus(terminalId, 'ready');
            database.updateTerminalState(terminalId, 'running');
            database.updateAgentProcessState(terminalId, 'running');
            this.states.publish(terminalId);
            if (database.getTerminal(terminalId)?.agentSessionId)
                this.options.coordinator.probeTerminal(terminalId);
            logger.write('info', logEventCatalog.agentChat.processStarted, {
                fields: { terminalId, outcome: 'ready', mode, durationMs: Date.now() - startedAt },
            });
        } catch (error) {
            if (state.session === session) state.session = undefined;
            await session?.close();
            if (isCurrent()) this.endpoint.retire(terminalId);
            const failure = chatStartFailure(this.options, terminal, error, startedAt);
            if (isCurrent() && !this.isShuttingDown) {
                this.states.setStatus(terminalId, 'failed', failure);
                if (didPersistChatStartFailure(this.options, terminalId, failure))
                    this.states.publish(terminalId);
            }
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
            forwardChatLifecycle(this.options, {
                ...(exit.requested
                    ? { phase: 'turnFinished', agentTurnId: exit.activeTurnId }
                    : {
                          phase: 'turnFailed',
                          agentTurnId: exit.activeTurnId,
                          agentFailure: 'provider_failed',
                      }),
                launchId,
                provider,
                terminalId,
            });
        state.session = undefined;
        state.launchId = undefined;
        this.endpoint.retire(terminalId);
        // Background work lives inside the provider process and ended with it.
        new ChatTaskList({
            read: () => state.projection.snapshot,
            apply: (operations) => this.states.apply(terminalId, operations),
        }).stopAll();
        this.options.coordinator.endTerminalLaunch(terminalId);
        if (!database.getTerminal(terminalId)) return;
        if (exit.requested) this.states.recordRequestedStop(terminalId, state);
        else {
            // No detail: the closed reason's own copy already says everything Caxri knows about the exit.
            this.states.setStatus(terminalId, 'failed', { reason: 'process_exited' });
            database.updateTerminalExitState(terminalId, 'dead');
            database.updateAgentProcessExitState(terminalId, 'dead');
        }
        this.states.publish(terminalId);
    }

    /**
     * Serializes input per Chat, starting the provider first, so messages and commands reach it in the order sent.
     */
    private enqueue(terminalId: string, deliver: ChatStateDelivery): Promise<void> {
        requireChatTerminal(this.options.database, terminalId);
        return this.enqueueOn(terminalId, this.states.open(terminalId), deliver);
    }

    /**
     * Appends input to one Chat state's send chain. The state is resolved once, by the caller, and admitted again when
     * the input reaches the head of the chain: input that waited behind a close, delete, archive, detach, restart, or
     * surface switch rejects there instead of starting a provider for the Terminal.
     */
    private async enqueueOn(
        terminalId: string,
        state: ChatState,
        deliver: ChatStateDelivery,
    ): Promise<void> {
        this.states.admit(terminalId, state);
        const previous = state.sendQueue;
        const run = (async () => {
            await previous;
            await deliver(await this.ensureStarted(terminalId, state), state);
        })();
        state.sendQueue = Promise.allSettled([run]);
        await run;
    }

    /**
     * Whether a Chat has a provider process or a start in flight, which is what a detach hands over.
     */
    private isLive(terminalId: string): boolean {
        return this.states.get(terminalId)?.session?.isOpen === true || this.starts.has(terminalId);
    }

    /**
     * Number of live provider processes, optionally limited to one Session. Counted as running work so Server Core idle
     * exit, the window-close confirmation, and Session deletion prompts treat a running Chat like a running PTY.
     */
    liveCount(sessionId?: string): number {
        return this.states.liveCount(sessionId);
    }

    /**
     * Whether a live Chat is inside a turn, which `terminal.switchSurface` asks before ending.
     */
    hasActiveTurn(terminalId: string): boolean {
        const state = this.states.get(terminalId);
        return Boolean(state?.session?.isOpen && state.projection.snapshot.activeTurnId);
    }

    /**
     * Returns the projection and lazily starts a provider that is not running. A failed Chat stays failed, and a
     * detached or closing one is refused by the admission fence, so neither relaunches on a read.
     */
    read(terminalId: string): AgentChatSnapshot {
        requireChatTerminal(this.options.database, terminalId);
        const state = this.states.open(terminalId);
        state.projection.flush();
        if (
            !state.session &&
            !this.starts.has(terminalId) &&
            state.projection.snapshot.status !== 'failed'
        )
            // eslint-disable-next-line no-void -- the read returns the starting projection; patches follow.
            void this.startQuietly(terminalId, state);
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
        await this.enqueue(terminalId, async (session, state) => {
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
        await this.enqueue(terminalId, async (session, state) => {
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

    async configure(terminalId: string, change: AgentChatModelRequest): Promise<void> {
        await this.enqueue(terminalId, async (session, state) => {
            const config = resolveAgentChatModelChange(state.projection.snapshot, change);
            if (config.model || config.effort) await session.configure?.(config);
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
        requireChatTerminal(this.options.database, terminalId);
        const state = this.states.open(terminalId);
        state.projection.flush();
        const live = state.projection.tasks.resolve(taskId);
        const listed = state.projection.snapshot.tasks?.find(
            (task) => task.id === taskId || task.itemId === taskId,
        );
        // Opening a running shell's tab confirms the provider still runs it; the list patch follows.
        if (listed?.kind === 'shell' && listed.status === 'running' && state.session?.isOpen)
            // eslint-disable-next-line no-void -- best effort: an unreadable list leaves the tasks as they are
            void state.session.refreshTasks?.().catch(() => {});
        if (live) return agentChatTaskSnapshotSchema.parse(live);
        let session: AgentChatProviderSession;
        try {
            session = await this.ensureStarted(terminalId, state);
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
        await this.enqueue(terminalId, async (session, state) => {
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
     * Stops the provider and starts it again on the same Agent Session. Clears a previous failure and ends a hand-over:
     * an explicit restart (Retry, a surface switch to Chat) is the user taking the Chat back. A resume keeps the
     * replaced start's approval mode (see `AgentRunAutonomy`). Queued follow-ups carry over; input still waiting in the
     * replaced state's send chain rejects.
     */
    async restart(terminalId: string, shouldKeepAgentAutonomy = false): Promise<TerminalRecord> {
        requireChatTerminal(this.options.database, terminalId);
        const previous = this.states.get(terminalId);
        if (previous) previous.retiring ??= 'replaced';
        await this.stop(terminalId);
        this.states.forget(terminalId);
        const terminal = requireChatTerminal(this.options.database, terminalId);
        if (terminal.lastProcessState === 'detached') this.states.clearDetached(terminalId);
        const state = this.states.open(terminalId);
        if (previous) state.followUps.adopt(previous.followUps);
        await this.startQuietly(terminalId, state, shouldKeepAgentAutonomy);
        return this.options.database.getTerminal(terminalId) ?? terminal;
    }

    /**
     * Stops a Chat whose Terminal is being closed, deleted, archived, detached, or switched to a PTY, and forgets its
     * projection. The state retires synchronously, before the stop awaits anything, so input queued behind it rejects.
     */
    async close(terminalId: string, reason: 'closed' | 'detached' = 'closed'): Promise<void> {
        const state = this.states.get(terminalId);
        if (state) state.retiring = reason;
        await this.stop(terminalId);
        this.states.forget(terminalId, true);
    }

    /**
     * Stops a Session's Chats for an archive (`closed`) or a hand-over to another client (`detached`). A detach parks
     * only the Chats that are live, as `detached`, mirroring `TerminalSuspensionService.detachSession` for PTYs: a read
     * then returns the projection without relaunching, and input fails, until `resumeSession` or an explicit restart.
     */
    async closeSession(sessionId: string, reason: 'closed' | 'detached' = 'closed'): Promise<void> {
        const ids = this.options.database
            .listTerminals(sessionId)
            .filter((terminal) => this.states.has(terminal.id))
            .map((terminal) => terminal.id);
        if (reason === 'closed') {
            await Promise.all(ids.map((id) => this.close(id)));
            return;
        }
        // Each Chat is marked as soon as it stops: a read between its stop and a sibling's would otherwise relaunch it.
        await Promise.all(
            ids
                .filter((id) => this.isLive(id))
                .map(async (id) => {
                    await this.close(id, 'detached');
                    this.states.markDetached(id);
                }),
        );
    }

    /**
     * `session.resume`: clears the hand-over marker on the Session's Chats and starts each provider again on its bound
     * Agent Session, as resume relaunches detached PTY Agents. Waiting for a read is not enough: a pane or phone that
     * read the Chat while it was detached already holds that projection and reads again only on a patch.
     */
    resumeSession(sessionId: string): void {
        for (const terminalId of this.states.clearDetachedSession(sessionId))
            // eslint-disable-next-line no-void -- a failed start is recorded in the projection every Client reads
            void this.startQuietly(terminalId, this.states.open(terminalId));
    }

    /**
     * Server Core shutdown. Durable process state is stamped by the shared shutdown path, so exits here write nothing.
     */
    async shutdown(): Promise<void> {
        this.isShuttingDown = true;
        for (const state of this.states.values()) state.retiring ??= 'closed';
        await Promise.all(this.states.terminalIds().map((id) => this.stop(id)));
        this.states.clear();
    }
}
