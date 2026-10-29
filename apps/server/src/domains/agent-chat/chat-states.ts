import type {
    AgentChatFailureReason,
    AgentChatPatchOperation,
    AgentChatRequest,
    AgentChatSnapshot,
    AgentProvider,
    ProcessState,
    ServerEvent,
    TerminalRecord,
} from '@caxri/protocol';
import { agentProviderCatalog, CaxriError, isChatTerminal } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import type { UsageGuardPath } from '../usage';
import { delegatedTaskDetails } from './chat-delegated-task';
import { requireChatTerminal } from './chat-launch';
import { ChatProjection } from './chat-projection';
import type { AgentChatProviderSession } from './chat-provider';
import { ChatFollowUpQueue } from './chat-queue';
import { chatStateStore } from './chat-state-store';
import { ChatSubagentSummaries } from './chat-subagent-summaries';
import { forgetTaskRevisions } from './chat-task-projections';
import type { ChatUsageContinuation } from './continuation/chat-usage-continuation';
import type { ChatUsageLimitWaits } from './continuation/chat-usage-limit-waits';
import type { ProjectionUsageLimitWaits } from './continuation/usage-continuation-stamp';

export type ChatTerminal = TerminalRecord & { provider: AgentProvider };

/**
 * Who asked a running turn to stop, as its fold label names it.
 */
export type ChatStopper = NonNullable<AgentChatSnapshot['turns'][number]['stoppedBy']>;

/**
 * Why a Chat state is being torn down: `closed` (close, delete, archive, surface switch, shutdown), `detached` (handed
 * to another client, recorded on the Terminal until `session.resume`), or `replaced` (restart).
 */
type ChatRetirement = 'closed' | 'detached' | 'replaced';

export interface ChatState {
    projection: ChatProjection;
    session?: AgentChatProviderSession;
    launchId?: string;
    /**
     * Settles after the last accepted send. Serializes sends so two quick messages cannot both start a turn.
     */
    sendQueue: Promise<unknown>;
    followUps: ChatFollowUpQueue;
    /**
     * Set synchronously when a teardown begins, before it awaits the provider. The admission fence refuses a retiring
     * state, so input queued behind the teardown, or a start racing it, can never spawn a provider for a Chat that is
     * going away. Reports from the session being stopped are deliberately not fenced by it: its final operations and
     * lifecycle events (an interrupted turn, resolved attention) must still land.
     */
    retiring?: ChatRetirement;
    /**
     * Set while idle suspension stops the provider, so its requested exit records `suspended` (restored on selection)
     * instead of `stopped`, whenever the exit lands. The next start clears it.
     */
    suspending?: boolean;
    /**
     * When a read started this Chat's provider, cleared by any input, so a provider that only exists because someone
     * looked at the Chat can be reclaimed (`CHAT_OBSERVATION_LEASE_MS`). Survives a reclaim, so the next read-started
     * provider of the same unused Chat is reclaimed too.
     */
    readLeaseAt?: number;
    /**
     * Side questions (`/btw` and the continuation handoff) the provider is answering now. They bypass the send chain
     * and leave the projection untouched, so suspension reads this count to avoid stopping the provider mid-answer.
     */
    sideQuestions?: number;
    /**
     * The Client request that started the running turn (`null` when no request did), taken by its
     * `agent_chat.turn_finished` record. Every provider start clears it.
     */
    turnStartRequestId?: string | null;
}

/**
 * Input delivery for a Chat's serialized send chain, given the state it was admitted under so it never re-resolves (and
 * so implicitly recreates) the Terminal's state after a teardown.
 */
export type ChatStateDelivery = (
    session: AgentChatProviderSession,
    state: ChatState,
) => Promise<void>;

interface ChatStatesOptions {
    database: CaxriDatabase;
    logger: StructuredLogger;
    send(event: ServerEvent): void;
    /**
     * Appends a dispatched follow-up to the state's send chain; see `AgentChatService.enqueueOn`.
     */
    enqueue(terminalId: string, state: ChatState, deliver: ChatStateDelivery): Promise<void>;
    onAgentStateChanged?(terminalId: string, state: ProcessState): void;
    /**
     * The weekly usage guard as each Chat sees it; see `ChatUsageContinuation`.
     */
    usage?: ChatUsageContinuation;
    /**
     * Each Chat's automatic continuation after a used-up plan limit; see `ChatUsageLimitWaits`.
     */
    usageLimitWaits?: ChatUsageLimitWaits;
}

/**
 * The Chat's open provider session, or an `UNAVAILABLE` error carrying the recorded start failure when it is not
 * running.
 */
export function requireOpenChatSession(
    state: ChatState,
    provider: AgentProvider,
): AgentChatProviderSession {
    if (state.session?.isOpen) return state.session;
    throw new CaxriError(
        'UNAVAILABLE',
        state.projection.snapshot.failure?.detail ??
            `${agentProviderCatalog[provider].displayName} Chat is not running`,
    );
}

/**
 * Every Chat Terminal's current in-memory state, the revision floors that outlive it, and the admission fence that
 * decides whether work may still reach or start a provider for it. It also writes the process state a stop leaves on
 * the Terminal row, because the fence reads the `detached` hand-over marker from there.
 */
export class ChatStates {
    private readonly states = new Map<string, ChatState>();

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

    /**
     * The durable subagent summaries the sidebar lists; see {@link ChatSubagentSummaries}.
     */
    private readonly subagents: ChatSubagentSummaries;

    constructor(private readonly options: ChatStatesOptions) {
        this.subagents = new ChatSubagentSummaries(options.database, (terminalId) =>
            this.publish(terminalId),
        );
        this.reconcileSubagentsOnStart();
    }

    /**
     * Runs once when Server Core builds this registry: persisted `running` subagents lost their provider with the
     * previous Server Core. Marks them `stopped` and logs how many rows that touched.
     */
    private reconcileSubagentsOnStart(): void {
        const terminalIds = this.subagents.reconcileOnStart();
        if (terminalIds.length === 0) return;
        this.options.logger.write('info', logEventCatalog.agentChatSubagents.reconciled, {
            fields: { reason: 'serverStart', terminals: terminalIds.length },
        });
    }

    private projectionWaits(
        terminalId: string,
        waits: ChatUsageLimitWaits,
    ): ProjectionUsageLimitWaits {
        return {
            stateOf: (turnId) => waits.stateOf(terminalId, turnId),
            replayNotice: () => waits.replayNotice(terminalId),
            observeGuardStop: (turnId) => {
                const provider = this.options.database.getTerminal(terminalId)?.provider;
                const guard = this.options.usage?.view(terminalId);
                // A guard that lifted before the stop landed leaves nothing to wait for.
                if (provider && guard)
                    waits.observeGuardStop(terminalId, provider, turnId, guard.resetsAt);
            },
            observeFailure: (notice) => {
                const provider = this.options.database.getTerminal(terminalId)?.provider;
                if (provider) waits.observeFailure(terminalId, provider, notice);
            },
        };
    }

    /**
     * The weekly usage guard and cross-Agent continuation, when Server Core composed them.
     */
    get usage(): ChatUsageContinuation | undefined {
        return this.options.usage;
    }

    /**
     * The automatic continuation after a used-up plan limit, when Server Core composed it.
     */
    get usageLimitWaits(): ChatUsageLimitWaits | undefined {
        return this.options.usageLimitWaits;
    }

    /**
     * Refuses an ordinary model request of this Chat while its account is at the weekly usage guard.
     */
    assertUsage(terminalId: string, path: UsageGuardPath): void {
        this.options.usage?.assert(terminalId, path);
    }

    get(terminalId: string): ChatState | undefined {
        return this.states.get(terminalId);
    }

    has(terminalId: string): boolean {
        return this.states.has(terminalId);
    }

    values(): MapIterator<ChatState> {
        return this.states.values();
    }

    terminalIds(): MapIterator<string> {
        return this.states.keys();
    }

    /**
     * The Terminal's current state, created (from its revision floors) when there is none.
     */
    open(terminalId: string): ChatState {
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
                onTasksChanged: (tasks) => this.subagents.record(terminalId, tasks),
                delegatedTask: (delegationId) =>
                    delegatedTaskDetails(this.options.database, delegationId),
                usageContinuedIn: (turnId) => this.options.usage?.continuedIn(terminalId, turnId),
                ...(this.options.usageLimitWaits && {
                    usageLimitWaits: this.projectionWaits(terminalId, this.options.usageLimitWaits),
                }),
                answeredNotices: {
                    load: () =>
                        chatStateStore(this.options.database).answeredNotices.list(terminalId),
                    save: (notice, after) =>
                        chatStateStore(this.options.database).answeredNotices.save(
                            terminalId,
                            notice,
                            after,
                        ),
                    remove: (itemIds) =>
                        chatStateStore(this.options.database).answeredNotices.remove(
                            terminalId,
                            itemIds,
                        ),
                },
            }),
            sendQueue: Promise.resolve(),
            followUps: new ChatFollowUpQueue({
                terminalId,
                logger: this.options.logger,
                read: () => state.projection.snapshot,
                apply: (operations) => this.apply(terminalId, operations),
                canDeliver: () =>
                    this.states.get(terminalId) === state &&
                    state.session?.isOpen === true &&
                    !this.options.usage?.isBlocked(terminalId),
                enqueue: (deliver) => this.options.enqueue(terminalId, state, deliver),
            }),
        };
        this.states.set(terminalId, state);
        const usageGuard = this.options.usage?.view(terminalId);
        if (usageGuard) state.projection.apply([{ op: 'state', state: { usageGuard } }]);
        return state;
    }

    apply(terminalId: string, operations: AgentChatPatchOperation[]): void {
        this.states.get(terminalId)?.projection.apply(operations);
    }

    setStatus(
        terminalId: string,
        status: AgentChatSnapshot['status'],
        failure?: { reason: AgentChatFailureReason; detail?: string },
    ): void {
        this.apply(terminalId, [{ op: 'state', state: { status, failure: failure ?? null } }]);
    }

    /**
     * Drops a Chat's projection without letting its pending patches reach Clients after a replacement chain began. A
     * closed Chat also drops its task revision floors; a restarted one keeps them. The projection's own revision floor
     * is dropped only once the Terminal row is gone (Terminal close, Session or Project delete): an archived Session or
     * a surface switch keeps the row and may open this Chat again, and its Clients still hold the old revision.
     */
    forget(terminalId: string, isClosed = false): void {
        const state = this.states.get(terminalId);
        if (state) {
            this.revisionFloors.set(terminalId, state.projection.retire());
            this.states.delete(terminalId);
            this.subagents.forget(terminalId);
        }
        if (isClosed) {
            forgetTaskRevisions(this.taskRevisionFloors, terminalId);
            if (!this.options.database.getTerminal(terminalId))
                this.revisionFloors.delete(terminalId);
        }
    }

    /**
     * Server Core shutdown: retires every projection at once.
     */
    clear(): void {
        for (const state of this.states.values()) state.projection.retire();
        this.states.clear();
    }

    /**
     * The one admission fence for work that would reach or start a provider: `state` must still be the Terminal's
     * current, non-retiring state, and the Terminal must still exist as a Chat that was not handed to another client.
     * Callers check it when input is accepted, again when that input reaches the head of the send chain, after a start
     * it joined, and right before a provider spawns, because each of those awaits leaves room for a close, delete,
     * archive, detach, restart, or surface switch.
     *
     * A Session that left the Workbench (archived, or its Project hidden) is refused too, the same predicate
     * `TerminalSuspensionService` parks a landing PTY launch with. Archive and hide write that mark before they close
     * the Session's Chats, but the close reaches only the states that exist then: a restart or a switch to Chat that
     * was stopping the old provider opens a fresh state afterward, and only this check keeps it from spawning.
     */
    admit(terminalId: string, state: ChatState): ChatTerminal {
        const { database } = this.options;
        const terminal = requireChatTerminal(database, terminalId);
        if (this.states.get(terminalId) !== state || state.retiring !== undefined)
            throw new CaxriError('CONFLICT', 'This Chat stopped before the input reached it');
        const session = database.getSession(terminal.sessionId);
        if (
            session &&
            (session.archivedAt !== undefined ||
                database.getProject(session.projectId)?.hiddenAt !== undefined)
        )
            throw new CaxriError(
                'CONFLICT',
                'This Chat belongs to an archived Session or a hidden Project',
            );
        if (terminal.lastProcessState === 'detached')
            throw new CaxriError(
                'UNAVAILABLE',
                'This Chat was detached for another client. Resume its Session to continue here.',
            );
        return terminal;
    }

    /**
     * Opens the Terminal's current state and passes it through {@link admit}.
     */
    admitOpen(terminalId: string): ChatState {
        const state = this.open(terminalId);
        this.admit(terminalId, state);
        return state;
    }

    isAdmitted(terminalId: string, state: ChatState): boolean {
        try {
            this.admit(terminalId, state);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Announces that a Chat's Terminal record changed.
     */
    publish(terminalId: string): void {
        this.options.send({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: [terminalId] },
        });
    }

    /**
     * Records a requested stop on the Terminal: `detached` for a hand-over, so the fence keeps refusing the Chat until
     * the Session resumes, and `stopped` otherwise.
     */
    recordRequestedStop(terminalId: string, state: ChatState): void {
        const processState =
            state.retiring === 'detached' ? 'detached' : state.suspending ? 'suspended' : 'stopped';
        if (this.states.get(terminalId) === state) this.setStatus(terminalId, 'stopped');
        this.writeProcessState(terminalId, processState);
    }

    /**
     * Durably writes a Chat's Terminal and Agent process state, then reports it through `onAgentStateChanged`.
     */
    writeProcessState(terminalId: string, processState: ProcessState): void {
        this.options.database.updateTerminalState(terminalId, processState);
        this.options.database.updateAgentProcessState(terminalId, processState);
        this.options.onAgentStateChanged?.(terminalId, processState);
    }

    /**
     * Writes the hand-over marker the fence reads when the stopping process did not (a start abandoned before it
     * spawned, or one that failed during the detach), so the next read cannot take the Agent Session back.
     */
    markDetached(terminalId: string): void {
        const { database } = this.options;
        const terminal = database.getTerminal(terminalId);
        if (!terminal || terminal.lastProcessState === 'detached') return;
        this.writeProcessState(terminalId, 'detached');
        this.publish(terminalId);
    }

    clearDetached(terminalId: string): void {
        // An explicit hand-back is use, not browsing.
        if (this.states.get(terminalId)) this.states.get(terminalId)!.readLeaseAt = undefined;
        this.options.database.updateTerminalState(terminalId, 'stopped');
        this.options.database.updateAgentProcessState(terminalId, 'stopped');
        this.publish(terminalId);
    }

    /**
     * Clears the hand-over marker on every detached Chat of a Session and returns the Chats it cleared.
     */
    clearDetachedSession(sessionId: string): string[] {
        const cleared = this.options.database
            .listTerminals(sessionId)
            .filter(
                (terminal) => isChatTerminal(terminal) && terminal.lastProcessState === 'detached',
            )
            .map((terminal) => terminal.id);
        for (const terminalId of cleared) this.clearDetached(terminalId);
        return cleared;
    }

    /**
     * Whether a live Chat is inside a turn.
     */
    hasActiveTurn(terminalId: string): boolean {
        const state = this.get(terminalId);
        return Boolean(state?.session?.isOpen && state.projection.snapshot.activeTurnId);
    }

    /**
     * The first request a Chat is waiting on, read from its in-memory projection; never opens or starts a Chat.
     */
    pendingRequest(terminalId: string): AgentChatRequest | undefined {
        return this.get(terminalId)?.projection.snapshot.requests.at(0);
    }

    /**
     * Whether any of a Session's Chats still runs a background shell or subagent, read from in-memory projections; a
     * turn can end while such work keeps going.
     */
    hasRunningTasks(sessionId: string): boolean {
        for (const [terminalId, state] of this.states) {
            if (!state.projection.snapshot.tasks?.some((task) => task.status === 'running'))
                continue;
            if (this.options.database.getTerminal(terminalId)?.sessionId === sessionId) return true;
        }
        return false;
    }

    /**
     * Number of live provider processes, optionally limited to one Session.
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
}
