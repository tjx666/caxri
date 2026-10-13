import { randomUUID } from 'node:crypto';

import type {
    AgentChatHistoryPage,
    AgentChatMessageInput,
    AgentChatModelRequest,
    AgentChatPermissionRequest,
    AgentChatResponse,
    AgentChatSnapshot,
    AgentChatTaskSnapshot,
    TerminalRecord,
} from '@caxri/protocol';
import {
    agentChatSnapshotSchema,
    agentProviderCatalog,
    CaxriError,
    resolveAgentChatModelChange,
} from '@caxri/protocol';
import { assertE2EAgentChatInput, readE2EAgentPolicy } from '@caxri/system';

import { AgentRunAutonomy } from '../agents';
import { SingleFlight } from '../single-flight';
import { readChatContext } from './chat-context';
import { ChatEndpointLease } from './chat-endpoint-lease';
import type { ChatExitHost } from './chat-exit';
import type { CreateForkSession } from './chat-fork';
import { forkChat } from './chat-fork';
import { readChatTerminalHistory } from './chat-history';
import { isAgentChatCommandListed } from './chat-items';
import { requireChatTerminal } from './chat-launch';
import { ChatPermissionSwitches } from './chat-permission-switch';
import type { AgentChatProviderSession } from './chat-provider';
import * as queueActions from './chat-queue-actions';
import type { ChatRewindRequest } from './chat-rewind';
import { restoreChatFiles, rewindChat } from './chat-rewind';
import type { ChatStartHost } from './chat-start';
import { startChat } from './chat-start';
import type { ChatState, ChatStateDelivery } from './chat-states';
import { ChatStates } from './chat-states';
import { isChatIdleForSuspension } from './chat-suspension';
import { readChatTask, stopChatTask } from './chat-task-read';
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

    private readonly permissionSwitches: ChatPermissionSwitches;

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
        this.permissionSwitches = new ChatPermissionSwitches({
            options,
            enqueue: (id, deliver) => this.enqueueOn(id, this.states.open(id), deliver),
            restart: (id) => this.restart(id, true),
            isLive: (id) => this.isLive(id),
            admit: (id) => this.states.admitOpen(id),
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
                startChat(this.startHost(), terminal, state, shouldKeepAgentAutonomy),
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
     * Serializes input per Chat, starting the provider first, so messages and commands reach it in the order sent.
     */
    private exitHost(): ChatExitHost {
        return {
            options: this.options,
            states: this.states,
            endpoint: this.endpoint,
            isSettling: (terminalId) => this.isShuttingDown || this.starts.has(terminalId),
        };
    }

    private startHost(): ChatStartHost {
        return {
            ...this.exitHost(),
            agentRunAutonomy: this.agentRunAutonomy,
            isShuttingDown: () => this.isShuttingDown,
        };
    }

    private queueHost(): queueActions.ChatQueueActionsHost {
        const { options, states } = this;
        return { options, states, enqueue: (id, deliver) => this.enqueue(id, deliver) };
    }

    /**
     * Appends input to the Chat's current send chain, after a pending permission switch (see `ChatPermissionSwitches`).
     */
    private async enqueue(terminalId: string, deliver: ChatStateDelivery): Promise<void> {
        requireChatTerminal(this.options.database, terminalId);
        await this.permissionSwitches.settled(terminalId);
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
            if (!session.isImmediateCommand?.(name) && state.followUps.mustWait()) {
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
            if (Object.keys(config).length > 0) await session.configure?.(config);
        });
    }

    /**
     * Switches the permission level or plan mode; see {@link ChatPermissionSwitches}.
     */
    setPermission(terminalId: string, request: AgentChatPermissionRequest): Promise<void> {
        return this.permissionSwitches.switch(terminalId, request);
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
     * Returns the page of history before `beforeItemId`; see {@link readChatTerminalHistory}.
     */
    readHistory(terminalId: string, beforeItemId: string): Promise<AgentChatHistoryPage> {
        return readChatTerminalHistory(this.options, this.states, terminalId, beforeItemId);
    }

    /**
     * Returns a task's own projection; see {@link readChatTask}.
     */
    readTask(terminalId: string, taskId: string): Promise<AgentChatTaskSnapshot> {
        requireChatTerminal(this.options.database, terminalId);
        const state = this.states.open(terminalId);
        return readChatTask(
            state,
            taskId,
            () => this.ensureStarted(terminalId, state),
            () => this.states.get(terminalId) === state,
        );
    }

    /**
     * Returns the Context tab's report; see {@link readChatContext}.
     */
    readContext(terminalId: string) {
        return readChatContext(this.options, terminalId, this.states.get(terminalId)?.session);
    }

    async stopTask(terminalId: string, taskId: string): Promise<void> {
        requireChatTerminal(this.options.database, terminalId);
        await stopChatTask(this.states.get(terminalId), taskId);
    }

    /**
     * The queue card's actions; see `chat-queue-actions.ts`.
     */
    removeQueued(terminalId: string, id: string): void {
        queueActions.removeQueued(this.queueHost(), terminalId, id);
    }

    takeQueued(terminalId: string, id: string): { text: string } {
        return queueActions.takeQueued(this.queueHost(), terminalId, id);
    }

    sendQueuedNow(terminalId: string, id: string): Promise<void> {
        return queueActions.sendQueuedNow(this.queueHost(), terminalId, id);
    }

    resumeQueue(terminalId: string): void {
        queueActions.resumeQueue(this.queueHost(), terminalId);
    }

    respond(terminalId: string, requestId: string, response: AgentChatResponse): void {
        requireChatTerminal(this.options.database, terminalId);
        const session = this.states.get(terminalId)?.session;
        if (!session) throw new CaxriError('CONFLICT', 'This request is no longer pending');
        session.respond(requestId, response);
    }

    /**
     * "Edit from here"; see {@link rewindChat}.
     */
    async rewind(terminalId: string, request: ChatRewindRequest): Promise<void> {
        await rewindChat(
            {
                options: this.options,
                enqueue: (id, deliver) => this.enqueue(id, deliver),
                restart: (id, resumeAt) => this.restart(id, true, resumeAt),
                send: (id, message) => this.send(id, message),
            },
            terminalId,
            request,
        );
    }

    /**
     * "Fork from here"; see {@link forkChat}.
     */
    fork(terminalId: string, itemId: string, createSession: CreateForkSession) {
        const host = { options: this.options, enqueue: this.enqueue.bind(this) };
        return forkChat(host, terminalId, itemId, createSession);
    }

    /**
     * "Restore code to here"; see {@link restoreChatFiles}.
     */
    async restoreFiles(terminalId: string, itemId: string): Promise<void> {
        await restoreChatFiles(
            { options: this.options, enqueue: (id, deliver) => this.enqueue(id, deliver) },
            terminalId,
            itemId,
        );
    }

    /**
     * Stops the provider and starts it again on the same Agent Session. Clears a previous failure and ends a hand-over:
     * an explicit restart (Retry, a surface switch to Chat) is the user taking the Chat back. A resume keeps the
     * replaced start's approval mode (see `AgentRunAutonomy`). Queued follow-ups carry over; input still waiting in the
     * replaced state's send chain rejects.
     */
    async restart(
        terminalId: string,
        shouldKeepAgentAutonomy = false,
        resumeAt?: string,
    ): Promise<TerminalRecord> {
        requireChatTerminal(this.options.database, terminalId);
        const previous = this.states.get(terminalId);
        if (previous) previous.retiring ??= 'replaced';
        await this.stop(terminalId);
        this.states.forget(terminalId);
        const terminal = requireChatTerminal(this.options.database, terminalId);
        if (terminal.lastProcessState === 'detached') this.states.clearDetached(terminalId);
        const state = this.states.open(terminalId);
        if (previous) {
            state.followUps.adopt(previous.followUps);
            state.projection.adoptReplaced(previous.projection);
        }
        /**
         * A rewound Claude Code conversation resumes at `resumeAt` until its next turn writes past it; a restart before
         * then (Retry after the edited message failed to send) must not resume the rewound branch again.
         */
        const carriedResumeAt = resumeAt ?? previous?.resumeAt;
        if (carriedResumeAt !== undefined) state.resumeAt = carriedResumeAt;
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
     * Whether idle suspension may stop this Chat now; see {@link isChatIdleForSuspension}.
     */
    isSuspendable(terminalId: string): boolean {
        const state = this.states.get(terminalId);
        const terminal = this.options.database.getTerminal(terminalId);
        return Boolean(
            state &&
            terminal &&
            !this.starts.has(terminalId) &&
            isChatIdleForSuspension(state, terminal),
        );
    }

    /**
     * The launch of a Chat whose provider is running and idle (see {@link isChatIdleForSuspension}), or `undefined`.
     * Batch compaction reads it so it never wakes a stopped Chat or interrupts pending work.
     */
    idleLaunchId(terminalId: string): string | undefined {
        return this.isSuspendable(terminalId) ? this.states.get(terminalId)?.launchId : undefined;
    }

    /**
     * Batch compaction: runs the provider's native compaction on an idle Chat, through the send chain, only while the
     * same launch is still idle when the command reaches the head of the chain. Rejects otherwise.
     */
    async compactIdle(terminalId: string, launchId: string): Promise<void> {
        assertE2EAgentChatInput(readE2EAgentPolicy(), '/compact');
        const state = this.states.get(terminalId);
        if (!state || state.launchId !== launchId)
            throw new CaxriError('CONFLICT', 'This Chat changed before compaction');
        await this.enqueueOn(terminalId, state, async (session) => {
            if (state.launchId !== launchId || this.idleLaunchId(terminalId) !== launchId)
                throw new CaxriError('CONFLICT', 'This Chat changed before compaction');
            if (!isAgentChatCommandListed(state.projection.snapshot, 'compact'))
                throw new CaxriError('VALIDATION', '/compact is not available in this Chat');
            await session.runCommand('compact', undefined);
        });
    }

    /**
     * Idle suspension: stops a background Chat's provider but keeps its projection, so every Client still shows the
     * conversation, and records the Terminal as `suspended`. It runs on the send chain, so input accepted before it is
     * delivered first and input accepted after it starts the provider again on the same Agent Session, as does the next
     * read or {@link resumeSuspended}. Returns the record, or `undefined` when the Chat was no longer idle.
     */
    async suspendIdle(terminalId: string): Promise<TerminalRecord | undefined> {
        const state = this.states.get(terminalId);
        if (!state) return undefined;
        const { database } = this.options;
        const previous = state.sendQueue;
        const run = (async () => {
            await previous;
            if (this.states.get(terminalId) !== state || !this.isSuspendable(terminalId)) return;
            await state.session?.close();
            state.session = undefined;
            // The requested exit recorded `stopped`; a suspension is resumable on selection instead.
            if (this.states.get(terminalId) !== state || !database.getTerminal(terminalId)) return;
            database.updateTerminalState(terminalId, 'suspended');
            database.updateAgentProcessState(terminalId, 'suspended');
            this.states.publish(terminalId);
            return database.getTerminal(terminalId);
        })();
        state.sendQueue = Promise.allSettled([run]);
        return run;
    }

    /**
     * Selecting a Session starts its suspended Chats again, as it restores suspended PTYs. Only a Chat this process
     * suspended is started: one an earlier Server Core left `suspended` resumes lazily on its next read, like any idle
     * Chat after a restart.
     */
    resumeSuspended(sessionId: string): void {
        for (const terminal of this.options.database.listTerminals(sessionId)) {
            const state = this.states.get(terminal.id);
            if (!state || state.session || terminal.lastProcessState !== 'suspended') continue;
            // eslint-disable-next-line no-void -- a failed start is recorded in the projection every Client reads
            void this.startQuietly(terminal.id, state);
        }
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
