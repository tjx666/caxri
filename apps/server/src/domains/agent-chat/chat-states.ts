import type {
    AgentChatFailureReason,
    AgentChatPatchOperation,
    AgentChatSnapshot,
    AgentProvider,
    ServerEvent,
    TerminalRecord,
} from '@caxri/protocol';
import { CaxriError, isChatTerminal } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import { requireChatTerminal } from './chat-launch';
import { ChatProjection } from './chat-projection';
import type { AgentChatProviderSession } from './chat-provider';
import { ChatFollowUpQueue } from './chat-queue';
import { forgetTaskRevisions } from './chat-task-projections';

export type ChatTerminal = TerminalRecord & { provider: AgentProvider };

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

    constructor(private readonly options: ChatStatesOptions) {}

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
            }),
            sendQueue: Promise.resolve(),
            followUps: new ChatFollowUpQueue({
                terminalId,
                logger: this.options.logger,
                read: () => state.projection.snapshot,
                apply: (operations) => this.apply(terminalId, operations),
                canDeliver: () =>
                    this.states.get(terminalId) === state && state.session?.isOpen === true,
                enqueue: (deliver) => this.options.enqueue(terminalId, state, deliver),
            }),
        };
        this.states.set(terminalId, state);
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
     * closed Chat also drops its task revision floors; a restarted one keeps them.
     */
    forget(terminalId: string, isClosed = false): void {
        const state = this.states.get(terminalId);
        if (state) {
            this.revisionFloors.set(terminalId, state.projection.retire());
            this.states.delete(terminalId);
        }
        if (isClosed) forgetTaskRevisions(this.taskRevisionFloors, terminalId);
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
        const { database } = this.options;
        const processState = state.retiring === 'detached' ? 'detached' : 'stopped';
        if (this.states.get(terminalId) === state) this.setStatus(terminalId, 'stopped');
        database.updateTerminalState(terminalId, processState);
        database.updateAgentProcessState(terminalId, processState);
    }

    /**
     * Writes the hand-over marker the fence reads when the stopping process did not (a start abandoned before it
     * spawned, or one that failed during the detach), so the next read cannot take the Agent Session back.
     */
    markDetached(terminalId: string): void {
        const { database } = this.options;
        const terminal = database.getTerminal(terminalId);
        if (!terminal || terminal.lastProcessState === 'detached') return;
        database.updateTerminalState(terminalId, 'detached');
        database.updateAgentProcessState(terminalId, 'detached');
        this.publish(terminalId);
    }

    clearDetached(terminalId: string): void {
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
