import type {
    DurableReceiptObservation,
    DurableRecoveryObservation,
    ServerEvent,
} from '@caxri/protocol';
import { logEventCatalog, serverEventPayloads, serverEventSchema } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

const MAX_REPORTED_EVENT_ISSUES = 5;
const MAX_EVENT_ISSUE_PATH_SEGMENTS = 8;
const MAX_EVENT_VALIDATION_FIELD_LENGTH = 512;

function safeIssuePath(path: readonly PropertyKey[]): string {
    return path
        .slice(0, MAX_EVENT_ISSUE_PATH_SEGMENTS)
        .map((segment) => {
            if (typeof segment === 'number') return '*';
            const value = String(segment);
            return /^[A-Z][\w-]{0,63}$/i.test(value) ? value : '<key>';
        })
        .join('.');
}

function valueAtPath(value: unknown, path: readonly PropertyKey[]): unknown {
    let current = value;
    for (const segment of path.slice(0, MAX_EVENT_ISSUE_PATH_SEGMENTS)) {
        if (typeof current !== 'object' || current === null) return undefined;
        current = (current as Record<PropertyKey, unknown>)[segment];
    }
    return current;
}

function knownEventName(value: unknown): string {
    if (typeof value !== 'object' || value === null) return 'unknown';
    const eventName: unknown = (value as Record<string, unknown>).event;
    return typeof eventName === 'string' && Object.hasOwn(serverEventPayloads, eventName)
        ? eventName
        : 'unknown';
}

/**
 * Validates the internal event immediately inside the EventTarget listener. Node rethrows listener exceptions on a
 * later tick, where the emitting domain can no longer catch them, so this boundary must reject malformed events before
 * a structured control or durable journal path uses `parse`. Diagnostics retain only schema paths, codes, and array
 * counts, never payloads.
 */
function validateServerEventForDelivery(
    logger: StructuredLogger,
    value: unknown,
): ServerEvent | undefined {
    const result = serverEventSchema.safeParse(value);
    if (result.success) return result.data;
    const issues = result.error.issues.slice(0, MAX_REPORTED_EVENT_ISSUES);
    const issueSummary = issues
        .map((issue) => `${safeIssuePath(issue.path)}:${issue.code}`)
        .join(',')
        .slice(0, MAX_EVENT_VALIDATION_FIELD_LENGTH);
    const arraySizes = issues
        .map((issue) => {
            const rejectedValue = valueAtPath(value, issue.path);
            return Array.isArray(rejectedValue)
                ? `${safeIssuePath(issue.path)}=${rejectedValue.length}`
                : undefined;
        })
        .filter((item): item is string => item !== undefined)
        .join(',')
        .slice(0, MAX_EVENT_VALIDATION_FIELD_LENGTH);
    try {
        logger.write('error', logEventCatalog.serverCore.eventRejected, {
            fields: {
                eventName: knownEventName(value),
                issueCount: result.error.issues.length,
                issues: issueSummary,
                ...(arraySizes && { arraySizes }),
            },
        });
    } catch {
        /**
         * A diagnostic sink failure must not restore the rejected event's original process-crash behavior.
         */
    }
    return undefined;
}

/**
 * Validates every internal event before a delivery branch dereferences its payload. Invalid events become the existing
 * full unknown-state invalidation so connected clients refetch instead of staying stale, while live PTYs survive.
 */
export function prepareServerEventForDelivery(
    logger: StructuredLogger,
    candidate: ServerEvent,
): ServerEvent {
    return (
        validateServerEventForDelivery(logger, candidate) ?? {
            event: 'state.changed',
            payload: { kind: 'full', reason: 'unknown' },
        }
    );
}

/**
 * Records a Terminal Host or Extension Host runtime status change, at `error` once the runtime reports failure.
 */
export function logRuntimeStatus(
    logger: StructuredLogger,
    payload: Extract<ServerEvent, { event: 'runtime.status' }>['payload'],
): void {
    logger.write(
        payload.status === 'failed' ? 'error' : 'info',
        logEventCatalog.serverCore.status,
        { fields: { status: payload.status, restartCount: payload.restartCount } },
    );
}

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
    logger.recordMetric('changefeed.lag', observation.eventCount, {
        owner: 'server-core',
        phase: 'recovery',
        outcome: 'success',
    });
    if (observation.outcome === 'snapshot')
        logger.recordMetric('changefeed.snapshot', 1, {
            owner: 'server-core',
            phase: 'recovery',
            outcome: 'success',
        });
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
