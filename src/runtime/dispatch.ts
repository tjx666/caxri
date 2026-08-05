import { toWireError } from '../shared/ipc/errors';
import type {
    RuntimeMethod,
    RuntimeMethodParams,
    RuntimeMethodResult,
} from '../shared/ipc/methods';
import { parseRuntimeRequest, type RuntimeResponse } from '../shared/ipc/transport';
import type { StructuredLogger } from '../shared/node/logger';

/**
 * Every Runtime-reachable method paired with its implementation. The mapped type is exhaustive, so a
 * method added to the shared table fails to compile until this Runtime provides a handler for it,
 * instead of failing at request time.
 */
export type RuntimeHandlers = {
    [M in RuntimeMethod]: (
        params: RuntimeMethodParams<M>,
    ) => Promise<RuntimeMethodResult<M>> | RuntimeMethodResult<M>;
};

/** The raw request as it arrives from Main; nothing about it is trusted before validation. */
export interface RuntimeRequestEnvelope {
    id: string;
    method: string;
    params: unknown;
}

export type RuntimeDispatcher = (envelope: RuntimeRequestEnvelope) => Promise<RuntimeResponse>;

/** PTY input and resize are measured by aggregated throughput metrics, never per-request log writes. */
const UNLOGGED_METHODS = new Set<string>(['terminal.input', 'terminal.resize']);

/**
 * Validates one request against the shared method table, runs its handler, and encodes the outcome
 * as a wire response. This is the only place that classifies Runtime faults for the wire.
 */
export function createDispatcher(
    handlers: RuntimeHandlers,
    logger: StructuredLogger,
): RuntimeDispatcher {
    return async (envelope) => {
        const started = performance.now();
        try {
            const request = parseRuntimeRequest(envelope.method, envelope.params);
            /**
             * `request` is a discriminated union, but a table lookup by a value cannot be correlated
             * with the method literal, so the handler is narrowed once here instead of per method.
             */
            const handler = handlers[request.method] as (params: unknown) => Promise<unknown>;
            const result = await handler(request.params);
            if (!UNLOGGED_METHODS.has(envelope.method)) {
                logger.write('debug', 'ipc.request', {
                    correlationId: envelope.id,
                    durationMs: performance.now() - started,
                    fields: { method: envelope.method },
                });
            }
            return { id: envelope.id, ok: true, result };
        } catch (error) {
            /** Zod failures become VALIDATION, CaxriError keeps its code, everything else is INTERNAL. */
            const wire = toWireError(error);
            logger.write('error', 'ipc.request_failed', {
                correlationId: envelope.id,
                durationMs: performance.now() - started,
                fields: {
                    method: envelope.method,
                    code: wire.code,
                    error: wire.message,
                    /** Only unclassified faults justify a stack trace in the Runtime log. */
                    stack:
                        wire.code === 'INTERNAL' && error instanceof Error
                            ? (error.stack ?? null)
                            : null,
                },
            });
            return { id: envelope.id, ok: false, error: wire };
        }
    };
}
