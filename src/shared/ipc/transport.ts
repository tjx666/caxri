import { z } from 'zod';

import { identifierSchema } from './domain';
import { CaxriError, fromWireError, toErrorCode, type WireError } from './errors';
import { runtimeEventSchema, type RuntimeEvent } from './events';
import {
    getMethodSpec,
    isCaxriMethod,
    methods,
    type CaxriMethod,
    type CaxriRequest,
    type MethodResult,
    type ParamsArg,
    type RuntimeMethod,
    type RuntimeMethodResult,
    type RuntimeRequest,
} from './methods';

export const requestEnvelopeSchema = z.object({
    id: identifierSchema,
    method: z.string().refine(isCaxriMethod),
    params: z.unknown(),
});

/**
 * Validates params once and pairs them with their method so downstream `switch` statements narrow
 * both together. The assertion is the single correlation point: `methods[method]` is resolved from a
 * value, which TypeScript cannot relate back to the method literal on its own.
 */
export function parseCaxriRequest(method: CaxriMethod, params: unknown): CaxriRequest {
    return { method, params: methods[method].params.parse(params) } as CaxriRequest;
}

/** Runtime-side equivalent that also accepts the internal Main-to-Runtime methods. */
export function parseRuntimeRequest(method: string, params: unknown): RuntimeRequest {
    const spec = getMethodSpec(method);
    if (!spec) throw new CaxriError('VALIDATION', `Unknown Runtime method: ${method}`);
    return { method, params: spec.params.parse(params) } as RuntimeRequest;
}

function invalidResult(method: string, issues: z.core.$ZodIssue[]): CaxriError {
    return new CaxriError('INTERNAL', `Invalid result returned for ${method}`, {
        issues: issues.slice(0, 5).map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
        })),
    });
}

/** Validates a Main or Runtime result before it crosses the Renderer IPC boundary. */
export function parseCaxriResult<M extends CaxriMethod>(
    method: M,
    result: unknown,
): MethodResult<M> {
    const parsed = methods[method].result.safeParse(result);
    if (!parsed.success) throw invalidResult(method, parsed.error.issues);
    return parsed.data as MethodResult<M>;
}

/** Validates a Runtime result, including internal Main-to-Runtime methods. */
export function parseRuntimeResult<M extends RuntimeMethod>(
    method: M,
    result: unknown,
): RuntimeMethodResult<M> {
    const spec = getMethodSpec(method);
    if (!spec) throw new CaxriError('INTERNAL', `Unknown Runtime result method: ${method}`);
    const parsed = spec.result.safeParse(result);
    if (!parsed.success) throw invalidResult(method, parsed.error.issues);
    return parsed.data as RuntimeMethodResult<M>;
}

const wireErrorSchema = z
    .object({
        code: z.unknown(),
        message: z.string().min(1),
        details: z.record(z.string(), z.unknown()).optional(),
    })
    .transform(({ code, message, details }): WireError => ({
        code: toErrorCode(code),
        message,
        ...(details ? { details } : {}),
    }));

const runtimeResponseSchema = z.discriminatedUnion('ok', [
    z.object({ id: identifierSchema, ok: z.literal(true), result: z.unknown() }),
    z.object({ id: identifierSchema, ok: z.literal(false), error: wireErrorSchema }),
]);

export type RuntimeResponse = z.infer<typeof runtimeResponseSchema>;

export type RuntimeMessage = RuntimeResponse | RuntimeEvent;

/** Parses an untrusted utility-process message as either a response or a declared Runtime event. */
export function parseRuntimeMessage(message: unknown): RuntimeMessage {
    const event = runtimeEventSchema.safeParse(message);
    if (event.success) return event.data;
    return runtimeResponseSchema.parse(message);
}

/** Main answers `caxri:request` with this envelope so the error code survives the Electron hop. */
export type CaxriReply = { ok: true; result: unknown } | { ok: false; error: WireError };

/** The same envelope once the method table has resolved the result shape. */
export type MethodReply<M extends CaxriMethod> =
    { ok: true; result: MethodResult<M> } | { ok: false; error: WireError };

/**
 * The preload allowlist. `request` resolves with a reply envelope instead of rejecting because
 * Electron's `contextBridge` copies only `message` and `stack` off a thrown Error: a `CaxriError`
 * raised in the preload would reach the Renderer as a plain `Error` with no `code`. The Renderer
 * rebuilds the typed error through {@link createCaxriClient}.
 */
export interface CaxriBridge {
    request<M extends CaxriMethod>(method: M, ...args: ParamsArg<M>): Promise<MethodReply<M>>;
    onEvent(listener: (event: RuntimeEvent) => void): () => void;
}

/** Renderer-facing view of the bridge: results are unwrapped and failures reject with `CaxriError`. */
export interface CaxriClient {
    request<M extends CaxriMethod>(method: M, ...args: ParamsArg<M>): Promise<MethodResult<M>>;
    onEvent(listener: (event: RuntimeEvent) => void): () => void;
}

export function createCaxriClient(bridge: CaxriBridge): CaxriClient {
    async function request<M extends CaxriMethod>(
        method: M,
        ...args: ParamsArg<M>
    ): Promise<MethodResult<M>> {
        const reply = await bridge.request(method, ...args);
        if (!reply.ok) throw fromWireError(reply.error);
        return reply.result;
    }
    return { request, onEvent: (listener) => bridge.onEvent(listener) };
}
