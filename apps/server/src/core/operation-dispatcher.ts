import type { ServerOperation, WorkbenchRequestContext } from '@caxri/protocol';
import {
    CaxriError,
    fromWireError,
    getMethodSpec,
    parseServerOperationRequest,
    toWireError,
    workbenchRequestContextSchema,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { currentObservationContext, logEventCatalog } from '@caxri/system';

import type { DomainHandlers, DomainOperation } from '../domains/domain-services';
import { requestActivity } from '../observability/request-activity';
import {
    delegationRequestLogFields,
    requestFailureLogLevel,
    shouldLogSuccessfulRequest,
} from './request-observability';

/**
 * The raw operation as it enters the domain layer; nothing about it is trusted before validation.
 */
interface DomainOperationEnvelope {
    context?: unknown;
    finalizeDurably?: <Result>(commit: () => Result) => Result;
    id: string;
    method: string;
    params: unknown;
}

export interface DomainOperationDispatcher {
    (envelope: DomainOperationEnvelope): Promise<unknown>;
    cancel(requestId: string): boolean;
}

type DomainHandler = (
    parameters: unknown,
    signal?: AbortSignal,
    finalizeDurably?: <Result>(commit: () => Result) => Result,
) => unknown;

/**
 * Looks up the handler for a validated operation. `DomainHandlers` covers only `DomainOperation`, so a registry method
 * Electron Main answers itself has no entry; if one still reaches Server it fails with a clear CONFLICT instead of
 * crashing on an `undefined` handler. `request` is a discriminated union, but a table lookup by a value cannot be
 * correlated with the method literal, so the handler is narrowed once here instead of per method.
 */
export function resolveDomainHandler(
    handlers: DomainHandlers,
    method: ServerOperation,
): DomainHandler {
    if (Object.hasOwn(handlers, method))
        return handlers[method as DomainOperation] as DomainHandler;
    throw new CaxriError(
        'CONFLICT',
        getMethodSpec(method)?.owner === 'desktop'
            ? `${method} must be handled by Electron Main`
            : `${method} has no Server domain handler`,
    );
}

const MAX_CANCEL_TOMBSTONES = 256;
const CANCEL_TOMBSTONE_TTL_MS = 30_000;

function pruneCancelTombstones(tombstones: Map<string, number>, now = Date.now()): void {
    for (const [requestId, expiresAt] of tombstones)
        if (expiresAt <= now) tombstones.delete(requestId);
    while (tombstones.size > MAX_CANCEL_TOMBSTONES)
        tombstones.delete(tombstones.keys().next().value!);
}

/**
 * Validates and executes one internal operation without imposing a process or serialization boundary.
 */
export function createOperationDispatcher(
    handlers: DomainHandlers,
    logger: StructuredLogger,
    validateContext?: (context: WorkbenchRequestContext) => void,
): DomainOperationDispatcher {
    const active = new Map<string, AbortController>();
    const cancelTombstones = new Map<string, number>();
    const dispatch = async (envelope: DomainOperationEnvelope): Promise<unknown> => {
        const started = performance.now();
        let cancellation: AbortController | undefined;
        try {
            const request = parseServerOperationRequest(envelope.method, envelope.params);
            if (envelope.context !== undefined) {
                const context = workbenchRequestContextSchema.parse(envelope.context);
                validateContext?.(context);
            }
            pruneCancelTombstones(cancelTombstones);
            if (cancelTombstones.delete(envelope.id))
                throw new CaxriError('CANCELLED', 'Runtime request was canceled before admission');
            const handler = resolveDomainHandler(handlers, request.method);
            cancellation = new AbortController();
            active.set(envelope.id, cancellation);
            // The control request's id (the observation context's) lets Git logs name their caller; the envelope id is
            // generated per domain call and matches nothing outside this layer.
            const endActivity = requestActivity.begin(
                currentObservationContext().requestId ?? envelope.id,
                request.method,
            );
            let result: unknown;
            try {
                result = await handler(
                    request.params,
                    cancellation.signal,
                    envelope.finalizeDurably,
                );
            } finally {
                endActivity();
            }
            if (cancellation.signal.aborted)
                throw new CaxriError('CANCELLED', 'Runtime request was canceled');
            if (shouldLogSuccessfulRequest('domain', envelope.method)) {
                logger.write('debug', logEventCatalog.ipc.request, {
                    correlationId: envelope.id,
                    durationMs: performance.now() - started,
                    fields: {
                        method: envelope.method,
                        ...delegationRequestLogFields(envelope.method, request.params, result),
                    },
                });
            }
            return result;
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
                    fields: {
                        method: envelope.method,
                        code: wire.code,
                        ...delegationRequestLogFields(envelope.method, envelope.params),
                    },
                });
            } else {
                logger.write(
                    requestFailureLogLevel(envelope.method, wire.code),
                    logEventCatalog.ipc.requestFailed,
                    {
                        correlationId: envelope.id,
                        durationMs: performance.now() - started,
                        fields: {
                            method: envelope.method,
                            code: wire.code,
                            ...delegationRequestLogFields(envelope.method, envelope.params),
                            error: wire.message,
                            /**
                             * Only unclassified faults justify a stack trace in the Server log.
                             */
                            stack:
                                wire.code === 'INTERNAL' && normalizedError instanceof Error
                                    ? (normalizedError.stack ?? null)
                                    : null,
                        },
                    },
                );
            }
            throw fromWireError(wire);
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
