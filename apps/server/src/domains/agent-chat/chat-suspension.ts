import type { TerminalRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { assertE2EAgentChatInput, readE2EAgentPolicy } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import { isAgentChatCommandListed } from './chat-items';
import type { ChatState, ChatStateDelivery, ChatStates } from './chat-states';

/**
 * Whether a live Chat can be stopped without losing anything the user has not seen: its provider is ready and bound to
 * an Agent Session it can resume, and no turn, approval, operation, background task, or queued message is pending. A
 * Chat that is not bound yet has no conversation to resume, so stopping it would only discard its draft settings.
 */
function isChatIdleForSuspension(
    state: ChatState | undefined,
    terminal: Pick<TerminalRecord, 'agentSessionId'> | undefined,
): boolean {
    if (!state || !terminal) return false;
    const snapshot = state.projection.snapshot;
    return (
        state.session?.isOpen === true &&
        state.retiring === undefined &&
        terminal.agentSessionId !== undefined &&
        snapshot.status === 'ready' &&
        snapshot.activeTurnId === undefined &&
        snapshot.requests.length === 0 &&
        snapshot.operation === undefined &&
        !snapshot.tasks?.some((task) => task.status === 'running') &&
        (snapshot.queue?.length ?? 0) === 0 &&
        (snapshot.queueLength ?? 0) === 0
    );
}

/**
 * What a Chat's maintenance sweeps need from the service that owns it.
 */
interface ChatIdleMaintenanceHost {
    database: Pick<CaxriDatabase, 'getTerminal'>;
    states: Pick<ChatStates, 'get' | 'assertUsage'>;
    hasStart(terminalId: string): boolean;
    enqueue(terminalId: string, state: ChatState, deliver: ChatStateDelivery): Promise<void>;
}

/**
 * Idle suspension, the observation lease's reclaim, and batch compaction of Chats, each decided against the Chat's own
 * projection and run on its send chain so input accepted first is delivered first.
 */
export class ChatIdleMaintenance {
    constructor(private readonly host: ChatIdleMaintenanceHost) {}

    /**
     * Whether idle suspension may stop this Chat now; see {@link isChatIdleForSuspension}.
     */
    isSuspendable(terminalId: string): boolean {
        const { database, states } = this.host;
        return (
            !this.host.hasStart(terminalId) &&
            isChatIdleForSuspension(states.get(terminalId), database.getTerminal(terminalId))
        );
    }

    readLeaseAt(terminalId: string): number | undefined {
        return this.host.states.get(terminalId)?.readLeaseAt;
    }

    /**
     * The launch of a Chat whose provider is running and idle, or `undefined`. Batch compaction reads it so it never
     * wakes a stopped Chat or interrupts pending work.
     */
    idleLaunchId(terminalId: string): string | undefined {
        return this.isSuspendable(terminalId)
            ? this.host.states.get(terminalId)?.launchId
            : undefined;
    }

    /**
     * Batch or idle compaction: runs the provider's native compaction on an idle Chat, through the send chain, only
     * while the same launch is still idle when the command reaches the head of the chain. Rejects otherwise. An `idle`
     * compaction labels its `compacted` notice so the transcript says Caxri ran it before the cache expired.
     */
    async compactIdle(
        terminalId: string,
        launchId: string,
        reason: 'batch' | 'idle' = 'batch',
    ): Promise<void> {
        const state = this.host.states.get(terminalId);
        assertE2EAgentChatInput(readE2EAgentPolicy(), '/compact');
        this.host.states.assertUsage(terminalId, 'idle_compaction');
        if (!state || state.launchId !== launchId)
            throw new CaxriError('CONFLICT', 'This Chat changed before compaction');
        await this.host.enqueue(terminalId, state, async (session) => {
            if (state.launchId !== launchId || this.idleLaunchId(terminalId) !== launchId)
                throw new CaxriError('CONFLICT', 'This Chat changed before compaction');
            if (!isAgentChatCommandListed(state.projection.snapshot, 'compact'))
                throw new CaxriError('VALIDATION', '/compact is not available in this Chat');
            if (reason === 'batch') return session.runCommand('compact', undefined);
            state.projection.noteIdleCompaction();
            try {
                await session.runCommand('compact', undefined);
            } catch (error) {
                state.projection.forgetIdleCompaction();
                throw error;
            }
        });
    }

    /**
     * Stops a background Chat's provider but keeps its projection, so every Client still shows the conversation, and
     * records the Terminal as `suspended`. It runs on the send chain, so input accepted before it is delivered first
     * and input accepted after it starts the provider again on the same Agent Session, as does the next read or
     * `resumeSuspended`. It stops only while the Chat is still the same one and idle when the stop reaches the head of
     * the chain; an `observation` stop also needs the read lease still held, because input since the decision means the
     * Chat is in use. Returns the record, or `undefined` when the Chat was no longer eligible.
     */
    async suspendIdle(
        terminalId: string,
        reason: 'idle' | 'observation',
    ): Promise<TerminalRecord | undefined> {
        const { database, states } = this.host;
        const state = states.get(terminalId);
        if (!state) return undefined;
        const previous = state.sendQueue;
        const run = (async () => {
            await previous;
            if (states.get(terminalId) !== state || !this.isSuspendable(terminalId)) return;
            if (reason === 'observation' && state.readLeaseAt === undefined) return;
            // The requested exit records `suspended` through this flag whenever it lands; a provider (Claude) may report
            // it after `close` resolves, and writing here instead could overwrite a start that began since.
            state.suspending = true;
            const { session } = state;
            await session?.close();
            if (state.session === session) state.session = undefined;
            return database.getTerminal(terminalId);
        })();
        state.sendQueue = Promise.allSettled([run]);
        return run;
    }
}

/**
 * Puts a Chat whose provider a read is about to start on an observation lease, when it has a conversation to resume:
 * the provider is only there so the Chat can be shown, and `enqueueOn` (any input) ends the lease. A Chat with no Agent
 * Session yet is new work, not history being browsed.
 */
export function leaseReadStart(
    database: Pick<CaxriDatabase, 'getTerminal'>,
    state: ChatState,
    terminalId: string,
): void {
    if (database.getTerminal(terminalId)?.agentSessionId !== undefined)
        state.readLeaseAt = Date.now();
}
