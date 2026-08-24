import type { RuntimeEvent } from '../registry/events.js';
import { CaxriError } from './errors.js';
import type {
    EventRecovery,
    ProtocolEventEnvelope,
    TransientRuntimeEvent,
} from './event-journal.js';
import { MAX_EVENT_JOURNAL_EVENTS } from './event-journal.js';

export interface RecoveringEventClient {
    /**
     * Requests the suffix (or bounded snapshot) needed by a newly attached client.
     */
    start(): Promise<void>;
    /**
     * Detaches the client and invalidates any recovery that still belongs to the previous listener set.
     */
    stop(): void;
    /**
     * Accepts Host-pushed envelopes; terminal output remains on its non-durable direct path.
     */
    receive(message: ProtocolEventEnvelope | TransientRuntimeEvent): void;
}

/**
 * Zero-dependency reconnect state machine for sandboxed preloads and other constrained clients. The Host dispatcher
 * already validates recovery results; this layer only orders their cursors.
 */
export function createRecoveringEventClient(options: {
    emit(event: RuntimeEvent): void;
    onError?(error: unknown): void;
    recover(afterCursor: number): Promise<EventRecovery>;
}): RecoveringEventClient {
    interface RecoveryState {
        generation: number;
        isQueuedOverflowed: boolean;
        promise?: Promise<void>;
        queued: ProtocolEventEnvelope[];
    }

    let cursor = 0;
    let isActive = true;
    let generation = 0;
    let recovery: RecoveryState | undefined;

    function isCurrent(state: RecoveryState): boolean {
        return isActive && recovery === state && generation === state.generation;
    }

    /**
     * A fresh journal recovery converges state when live delivery outpaces the bounded queue.
     */
    function queue(state: RecoveryState, envelope: ProtocolEventEnvelope): void {
        if (state.isQueuedOverflowed) return;
        if (state.queued.length >= MAX_EVENT_JOURNAL_EVENTS) {
            state.queued.length = 0;
            state.isQueuedOverflowed = true;
            return;
        }
        state.queued.push(envelope);
    }

    function didAcceptSuffix(
        state: RecoveryState,
        events: readonly ProtocolEventEnvelope[],
    ): boolean {
        for (const envelope of events) {
            if (!isCurrent(state)) return false;
            if (envelope.cursor <= cursor) continue;
            if (envelope.cursor !== cursor + 1)
                throw new CaxriError('INTERNAL', 'Host returned a non-contiguous event suffix');
            cursor = envelope.cursor;
            options.emit(envelope.event);
        }
        return isCurrent(state);
    }

    function didAcceptQueued(
        state: RecoveryState,
        events: readonly ProtocolEventEnvelope[],
    ): boolean {
        for (const envelope of events) {
            if (!isCurrent(state)) return false;
            if (envelope.cursor <= cursor) continue;
            if (envelope.cursor !== cursor + 1) return false;
            cursor = envelope.cursor;
            options.emit(envelope.event);
        }
        return isCurrent(state);
    }

    /**
     * Drains the live-event queue accumulated during recovery, applying each batch in order.
     */
    function didDrainQueue(state: RecoveryState): boolean {
        while (isCurrent(state) && !state.isQueuedOverflowed && state.queued.length > 0) {
            const batch = state.queued.slice();
            state.queued.length = 0;
            if (!didAcceptQueued(state, batch)) return false;
        }
        return isCurrent(state);
    }

    async function recoverUntilCaughtUp(state: RecoveryState): Promise<void> {
        while (isCurrent(state)) {
            // eslint-disable-next-line no-await-in-loop -- each retry depends on whether the previous recovery converged; the loop cannot be parallelized.
            const result = await options.recover(cursor);
            if (!isCurrent(state)) return;
            if (state.isQueuedOverflowed) {
                state.queued.length = 0;
                state.isQueuedOverflowed = false;
                continue;
            }
            if (result.kind === 'snapshot') {
                cursor = result.cursor;
                options.emit({
                    event: 'state.changed',
                    payload: { kind: 'full', reason: 'unknown' },
                });
                if (!isCurrent(state)) return;
            } else if (!didAcceptSuffix(state, result.events)) return;
            // `isQueuedOverflowed` cannot flip true between the guard above and here: everything in
            // this branch (didAcceptSuffix/didDrainQueue) runs synchronously, and it was already false
            // to reach this branch.
            const isDrained = didDrainQueue(state);
            if (!isCurrent(state)) return;
            if (isDrained) return;
            state.queued.length = 0;
            state.isQueuedOverflowed = false;
        }
    }

    async function settleRecovery(state: RecoveryState): Promise<void> {
        try {
            await recoverUntilCaughtUp(state);
        } catch (error) {
            if (isCurrent(state)) options.onError?.(error);
        } finally {
            if (recovery === state) {
                recovery = undefined;
                const pending = state.queued.slice();
                state.queued.length = 0;
                const isOverflowed = state.isQueuedOverflowed;
                state.isQueuedOverflowed = false;
                if (isActive && generation === state.generation) {
                    if (isOverflowed) {
                        // eslint-disable-next-line no-void -- fire-and-forget restart; the resulting promise self-handles its own errors via settleRecovery's try/catch, and this synchronous finally block cannot await it.
                        void scheduleRecovery();
                    } else {
                        for (const envelope of pending) acceptLive(envelope);
                    }
                }
            }
        }
    }

    function scheduleRecovery(initialEnvelope?: ProtocolEventEnvelope): Promise<void> {
        isActive = true;
        if (recovery?.promise) {
            if (initialEnvelope) queue(recovery, initialEnvelope);
            return recovery.promise;
        }
        const state: RecoveryState = {
            generation,
            isQueuedOverflowed: false,
            queued: [],
        };
        recovery = state;
        if (initialEnvelope) queue(state, initialEnvelope);
        state.promise = settleRecovery(state);
        return state.promise;
    }

    function acceptLive(envelope: ProtocolEventEnvelope): void {
        if (!isActive) return;
        if (recovery) {
            queue(recovery, envelope);
            return;
        }
        if (envelope.cursor <= cursor) return;
        if (envelope.cursor !== cursor + 1) {
            // eslint-disable-next-line no-void -- fire-and-forget restart; the resulting promise self-handles its own errors via settleRecovery's try/catch, and `acceptLive` is a synchronous event handler that cannot await it.
            void scheduleRecovery(envelope);
            return;
        }
        cursor = envelope.cursor;
        options.emit(envelope.event);
    }

    return {
        start: scheduleRecovery,
        stop() {
            isActive = false;
            generation += 1;
            if (recovery) {
                recovery.queued.length = 0;
                recovery.isQueuedOverflowed = false;
                recovery = undefined;
            }
        },
        receive(message) {
            if (!isActive) return;
            if ('cursor' in message) acceptLive(message);
            else options.emit(message);
        },
    };
}
