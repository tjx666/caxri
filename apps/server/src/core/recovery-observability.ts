import type { DurableReceiptObservation, DurableRecoveryObservation } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

/**
 * Emits content-free recovery timings and outcomes. Command parameters, replies, event payloads, credentials, and
 * environment values are intentionally unrepresentable in these observation types.
 */
export function logDurableReceipt(
    logger: StructuredLogger,
    observation: DurableReceiptObservation,
): void {
    logger.write(
        observation.outcome === 'failed'
            ? 'warn'
            : observation.outcome === 'hit'
              ? 'info'
              : 'debug',
        logEventCatalog.serverCore.commandReceipt,
        {
            durationMs: observation.durationMs,
            fields: {
                method: observation.method,
                outcome: observation.outcome,
                phase: observation.phase,
            },
        },
    );
}

export function logDurableRecovery(
    logger: StructuredLogger,
    observation: DurableRecoveryObservation,
): void {
    logger.write(
        observation.outcome === 'snapshot' ? 'info' : 'debug',
        logEventCatalog.serverCore.eventRecovery,
        {
            durationMs: observation.durationMs,
            fields: {
                cursor: observation.cursor,
                eventCount: observation.eventCount,
                outcome: observation.outcome,
                reason: observation.reason,
            },
        },
    );
}
