import type {
    RuntimeMethod,
    RuntimeMethodParams as RuntimeMethodParameters,
    RuntimeMethodResult,
    RuntimeResponse,
    RuntimeWorkbenchContext,
} from '@caxri/protocol';
import {
    CaxriError,
    parseRuntimeRequest,
    runtimeWorkbenchContextSchema,
    toWireError,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

/**
 * Every Runtime-reachable method paired with its implementation. The mapped type is exhaustive, so a method added to
 * the shared table fails to compile until this Runtime provides a handler for it, instead of failing at request time.
 */
export type RuntimeHandlers = {
    [M in RuntimeMethod]: (
        parameters: RuntimeMethodParameters<M>,
        signal?: AbortSignal,
    ) => Promise<RuntimeMethodResult<M>> | RuntimeMethodResult<M>;
};

/**
 * The raw request as it arrives from Main; nothing about it is trusted before validation.
 */
export interface RuntimeRequestEnvelope {
    context?: unknown;
    id: string;
    method: string;
    params: unknown;
}

export interface RuntimeDispatcher {
    (envelope: RuntimeRequestEnvelope): Promise<RuntimeResponse>;
    cancel(requestId: string): boolean;
}

/**
 * PTY input and resize are measured by aggregated throughput metrics, never per-request log writes.
 */
const UNLOGGED_METHODS = new Set<string>(['terminal.input', 'terminal.resize']);
const MAX_CANCEL_TOMBSTONES = 256;
const CANCEL_TOMBSTONE_TTL_MS = 30_000;

function pruneCancelTombstones(tombstones: Map<string, number>, now = Date.now()): void {
    for (const [requestId, expiresAt] of tombstones)
        if (expiresAt <= now) tombstones.delete(requestId);
    while (tombstones.size > MAX_CANCEL_TOMBSTONES)
        tombstones.delete(tombstones.keys().next().value!);
}

/**
 * Validates one request against the shared method table, runs its handler, and encodes the outcome as a wire response.
 * This is the only place that classifies Runtime faults for the wire.
 */
export function createDispatcher(
    handlers: RuntimeHandlers,
    logger: StructuredLogger,
    validateContext?: (context: RuntimeWorkbenchContext) => void,
): RuntimeDispatcher {
    const active = new Map<string, AbortController>();
    const cancelTombstones = new Map<string, number>();
    const dispatch = async (envelope: RuntimeRequestEnvelope): Promise<RuntimeResponse> => {
        const started = performance.now();
        let cancellation: AbortController | undefined;
        try {
            const request = parseRuntimeRequest(envelope.method, envelope.params);
            if (envelope.context !== undefined) {
                const context = runtimeWorkbenchContextSchema.parse(envelope.context);
                validateContext?.(context);
            }
            pruneCancelTombstones(cancelTombstones);
            if (cancelTombstones.delete(envelope.id))
                throw new CaxriError('CANCELLED', 'Runtime request was canceled before admission');
            /**
             * `request` is a discriminated union, but a table lookup by a value cannot be correlated with the method
             * literal, so the handler is narrowed once here instead of per method.
             */
            cancellation = new AbortController();
            active.set(envelope.id, cancellation);
            const handler = handlers[request.method] as (
                parameters: unknown,
                signal: AbortSignal,
            ) => Promise<unknown>;
            const result = await handler(request.params, cancellation.signal);
            if (cancellation.signal.aborted)
                throw new CaxriError('CANCELLED', 'Runtime request was canceled');
            if (!UNLOGGED_METHODS.has(envelope.method)) {
                logger.write('debug', logEventCatalog.ipc.request, {
                    correlationId: envelope.id,
                    durationMs: performance.now() - started,
                    fields: { method: envelope.method },
                });
            }
            return { id: envelope.id, ok: true, result };
        } catch (error) {
            /**
             * Zod failures become VALIDATION, CaxriError keeps its code, everything else is INTERNAL.
             */
            const normalizedError = cancellation?.signal.aborted
                ? new CaxriError('CANCELLED', 'Runtime request was canceled')
                : error;
            const wire = toWireError(normalizedError);
            if (wire.code === 'CANCELLED') {
                logger.write('debug', logEventCatalog.ipc.request, {
                    correlationId: envelope.id,
                    durationMs: performance.now() - started,
                    fields: { method: envelope.method, code: wire.code },
                });
            } else {
                logger.write('error', logEventCatalog.ipc.requestFailed, {
                    correlationId: envelope.id,
                    durationMs: performance.now() - started,
                    fields: {
                        method: envelope.method,
                        code: wire.code,
                        error: wire.message,
                        /**
                         * Only unclassified faults justify a stack trace in the Runtime log.
                         */
                        stack:
                            wire.code === 'INTERNAL' && normalizedError instanceof Error
                                ? (normalizedError.stack ?? null)
                                : null,
                    },
                });
            }
            return { id: envelope.id, ok: false, error: wire };
        } finally {
            if (cancellation && active.get(envelope.id) === cancellation)
                active.delete(envelope.id);
        }
    };
    dispatch.cancel = (requestId: string): boolean => {
        const cancellation = active.get(requestId);
        if (cancellation) {
            cancellation.abort();
            return true;
        }
        pruneCancelTombstones(cancelTombstones);
        cancelTombstones.set(requestId, Date.now() + CANCEL_TOMBSTONE_TTL_MS);
        pruneCancelTombstones(cancelTombstones);
        return true;
    };
    return dispatch;
}
