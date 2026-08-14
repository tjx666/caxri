import { CaxriError } from './errors.js';
import {
    MAX_EVENT_JOURNAL_EVENTS,
    type EventRecovery,
    type ProtocolEventEnvelope,
    type TransientRuntimeEvent,
} from './event-journal.js';
import type { RuntimeEvent } from '../registry/events.js';

export interface RecoveringEventClient {
    /** Requests the suffix (or bounded snapshot) needed by a newly attached client. */
    start(): Promise<void>;
    /** Accepts Host-pushed envelopes; terminal output remains on its non-durable direct path. */
    receive(message: ProtocolEventEnvelope | TransientRuntimeEvent): void;
}

/**
 * Zero-dependency reconnect state machine for sandboxed preloads and other constrained clients.
 * The Host dispatcher already validates recovery results; this layer only orders their cursors.
 */
export function createRecoveringEventClient(options: {
    emit(event: RuntimeEvent): void;
    onError?(error: unknown): void;
    recover(afterCursor: number): Promise<EventRecovery>;
}): RecoveringEventClient {
    let cursor = 0;
    let recovery: Promise<void> | undefined;
    const queued: ProtocolEventEnvelope[] = [];
    let queuedOverflowed = false;

    /** A fresh journal recovery converges state when live delivery outpaces the bounded queue. */
    function queue(envelope: ProtocolEventEnvelope): void {
        if (queuedOverflowed) return;
        if (queued.length >= MAX_EVENT_JOURNAL_EVENTS) {
            queued.length = 0;
            queuedOverflowed = true;
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

    function acceptQueued(events: readonly ProtocolEventEnvelope[]): boolean {
        for (const envelope of events) {
            if (envelope.cursor <= cursor) continue;
            if (envelope.cursor !== cursor + 1) return false;
            cursor = envelope.cursor;
            options.emit(envelope.event);
        }
        return true;
    }

    async function recoverUntilCaughtUp(): Promise<void> {
        while (true) {
            const result = await options.recover(cursor);
            if (queuedOverflowed) {
                queued.length = 0;
                queuedOverflowed = false;
                continue;
            }
            if (result.kind === 'snapshot') {
                cursor = result.cursor;
                options.emit({
                    event: 'state.changed',
                    payload: { kind: 'full', reason: 'unknown' },
                });
            } else acceptSuffix(result.events);
            let requiresRecovery = false;
            while (queued.length > 0 && !queuedOverflowed) {
                if (!acceptQueued(queued.splice(0))) {
                    requiresRecovery = true;
                    break;
                }
            }
            if (!queuedOverflowed && !requiresRecovery) return;
            queued.length = 0;
            queuedOverflowed = false;
        }
    }

    function scheduleRecovery(): Promise<void> {
        if (recovery) return recovery;
        recovery = recoverUntilCaughtUp()
            .catch((error: unknown) => options.onError?.(error))
            .finally(() => {
                recovery = undefined;
                const pending = queued.splice(0);
                const overflowed = queuedOverflowed;
                queuedOverflowed = false;
                if (overflowed) {
                    void scheduleRecovery();
                    return;
                }
                for (const envelope of pending) acceptLive(envelope);
            });
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
