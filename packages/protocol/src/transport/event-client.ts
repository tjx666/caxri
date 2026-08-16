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
    let cursor = 0;
    let recovery: Promise<void> | undefined;
    const queued: ProtocolEventEnvelope[] = [];
    let isQueuedOverflowed = false;

    /**
     * A fresh journal recovery converges state when live delivery outpaces the bounded queue.
     */
    function queue(envelope: ProtocolEventEnvelope): void {
        if (isQueuedOverflowed) return;
        if (queued.length >= MAX_EVENT_JOURNAL_EVENTS) {
            queued.length = 0;
            isQueuedOverflowed = true;
            return;
        }
        queued.push(envelope);
    }

    function acceptSuffix(events: readonly ProtocolEventEnvelope[]): void {
        for (const envelope of events) {
            if (envelope.cursor <= cursor) continue;
            if (envelope.cursor !== cursor + 1)
                throw new CaxriError('INTERNAL', 'Host returned a non-contiguous event suffix');
            cursor = envelope.cursor;
            options.emit(envelope.event);
        }
    }

    function didAcceptQueued(events: readonly ProtocolEventEnvelope[]): boolean {
        for (const envelope of events) {
            if (envelope.cursor <= cursor) continue;
            if (envelope.cursor !== cursor + 1) return false;
            cursor = envelope.cursor;
            options.emit(envelope.event);
        }
        return true;
    }

    /**
     * Drains the live-event queue accumulated during recovery, applying each batch in order.
     */
    function didDrainQueue(): boolean {
        while (!isQueuedOverflowed && queued.length > 0) {
            const batch = queued.slice();
            queued.length = 0;
            if (!didAcceptQueued(batch)) return false;
        }
        return true;
    }

    async function recoverUntilCaughtUp(): Promise<void> {
        while (true) {
            // eslint-disable-next-line no-await-in-loop -- each retry depends on whether the previous recovery converged; the loop cannot be parallelized.
            const result = await options.recover(cursor);
            if (isQueuedOverflowed) {
                queued.length = 0;
                isQueuedOverflowed = false;
                continue;
            }
            if (result.kind === 'snapshot') {
                cursor = result.cursor;
                options.emit({
                    event: 'state.changed',
                    payload: { kind: 'full', reason: 'unknown' },
                });
            } else acceptSuffix(result.events);
            const isDrained = didDrainQueue();
            if (!isQueuedOverflowed && isDrained) return;
            queued.length = 0;
            isQueuedOverflowed = false;
        }
    }

    async function settleRecovery(): Promise<void> {
        try {
            await recoverUntilCaughtUp();
        } catch (error) {
            options.onError?.(error);
        } finally {
            recovery = undefined;
            const pending = queued.slice();
            queued.length = 0;
            const isOverflowed = isQueuedOverflowed;
            isQueuedOverflowed = false;
            if (isOverflowed) {
                // eslint-disable-next-line no-void -- fire-and-forget restart; the resulting promise self-handles its own errors via settleRecovery's try/catch, and this synchronous finally block cannot await it.
                void scheduleRecovery();
            } else {
                for (const envelope of pending) acceptLive(envelope);
            }
        }
    }

    function scheduleRecovery(): Promise<void> {
        if (recovery) return recovery;
        recovery = settleRecovery();
        return recovery;
    }

    function acceptLive(envelope: ProtocolEventEnvelope): void {
        if (recovery) {
            queue(envelope);
            return;
        }
        if (envelope.cursor <= cursor) return;
        if (envelope.cursor !== cursor + 1) {
            queue(envelope);
            // eslint-disable-next-line no-void -- fire-and-forget restart; the resulting promise self-handles its own errors via settleRecovery's try/catch, and `acceptLive` is a synchronous event handler that cannot await it.
            void scheduleRecovery();
            return;
        }
        cursor = envelope.cursor;
        options.emit(envelope.event);
    }

    return {
        start: scheduleRecovery,
        receive(message) {
            if ('cursor' in message) acceptLive(message);
            else options.emit(message);
        },
    };
}
