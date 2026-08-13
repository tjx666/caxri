import { CaxriError } from './errors.js';
import type {
    EventRecovery,
    ProtocolEventEnvelope,
    TransientRuntimeEvent,
} from './event-journal.js';
import type { RuntimeEvent } from './events.js';

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

    function acceptSuffix(events: readonly ProtocolEventEnvelope[]): void {
        for (const envelope of events) {
            if (envelope.cursor <= cursor) continue;
            if (envelope.cursor !== cursor + 1)
                throw new CaxriError('INTERNAL', 'Host returned a non-contiguous event suffix');
            cursor = envelope.cursor;
            options.emit(envelope.event);
        }
    }

    function scheduleRecovery(): Promise<void> {
        if (recovery) return recovery;
        recovery = (async () => {
            const result = await options.recover(cursor);
            if (result.kind === 'snapshot') {
                cursor = result.cursor;
                options.emit({
                    event: 'state.changed',
                    payload: { kind: 'full', reason: 'unknown' },
                });
            } else acceptSuffix(result.events);
        })()
            .catch((error: unknown) => options.onError?.(error))
            .finally(() => {
                recovery = undefined;
                const pending = queued.splice(0);
                for (const envelope of pending) acceptLive(envelope);
            });
        return recovery;
    }

    function acceptLive(envelope: ProtocolEventEnvelope): void {
        if (recovery) {
            queued.push(envelope);
            return;
        }
        if (envelope.cursor <= cursor) return;
        if (envelope.cursor !== cursor + 1) {
            queued.push(envelope);
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
