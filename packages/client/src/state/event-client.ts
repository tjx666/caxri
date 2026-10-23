import type {
    EventRecovery,
    ProtocolEventEnvelope,
    ServerEvent,
    TransientServerEvent,
} from '@caxri/protocol';
import { CaxriError, MAX_EVENT_JOURNAL_EVENTS } from '@caxri/protocol';

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
     * Accepts Server-pushed envelopes; terminal output remains on its non-durable direct path.
     */
    receive(message: ProtocolEventEnvelope | TransientServerEvent): void;
}

/**
 * Zero-dependency reconnect state machine for sandboxed preloads and other constrained clients. The Server dispatcher
 * already validates recovery results; this layer only orders their cursors.
 */
export function createRecoveringEventClient(options: {
    emit(event: ServerEvent): void;
    identity?: { serverId: string; stateEpoch: string };
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

    function assertEnvelopeIdentity(envelope: ProtocolEventEnvelope): void {
        if (!options.identity) return;
        if (
            envelope.serverId !== options.identity.serverId ||
            envelope.stateEpoch !== options.identity.stateEpoch
        )
            throw new CaxriError('CONFLICT', 'Event belongs to a different Server history');
    }

    function assertRecoveryIdentity(result: EventRecovery): void {
        if (!options.identity) return;
        if (
            result.serverId !== options.identity.serverId ||
            result.stateEpoch !== options.identity.stateEpoch ||
            result.barrier?.cursor !== result.cursor
        )
            throw new CaxriError(
                'CONFLICT',
                'Recovery barrier belongs to a different Server history',
            );
    }

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
            assertEnvelopeIdentity(envelope);
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
            assertEnvelopeIdentity(envelope);
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
            assertRecoveryIdentity(result);
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
        let didFail = false;
        try {
            await recoverUntilCaughtUp(state);
        } catch (error) {
            didFail = true;
            if (isCurrent(state)) options.onError?.(error);
        } finally {
            if (recovery === state) {
                recovery = undefined;
                const pending = state.queued.slice();
                state.queued.length = 0;
                const isOverflowed = state.isQueuedOverflowed;
                state.isQueuedOverflowed = false;
                /**
                 * A failed recovery must drop its queue instead of replaying it: every queued envelope still has the
                 * same cursor gap, so replaying would reschedule recovery synchronously and, while the transport keeps
                 * rejecting (for example after Desktop disposal), spin the process in a hot loop. The next live gap or
                 * an explicit `start()` on reconnect restarts recovery from real input instead.
                 */
                if (!didFail && isActive && generation === state.generation) {
                    if (isOverflowed) {
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
        try {
            assertEnvelopeIdentity(envelope);
        } catch (error) {
            options.onError?.(error);
            return;
        }
        if (recovery) {
            queue(recovery, envelope);
            return;
        }
        if (envelope.cursor <= cursor) return;
        if (envelope.cursor !== cursor + 1) {
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
