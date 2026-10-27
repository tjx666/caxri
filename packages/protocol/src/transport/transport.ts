import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import type { ServerEvent } from '../registry/events.js';
import type {
    CaxriMethod,
    CaxriRequest,
    MethodResult,
    ParametersArgument,
    ServerOperation,
    ServerOperationRequest,
    ServerOperationResult,
} from '../registry/methods.js';
import { getMethodSpec, isCaxriMethod, methods } from '../registry/methods.js';
import type { WireError } from './errors.js';
import { CaxriError, fromWireError, toErrorCode } from './errors.js';
import type { RendererDiagnostic } from './renderer-diagnostic.js';
import type { RendererErrorKind } from './renderer-error.js';
import type { CAXRI_PROTOCOL_VERSION, ProtocolWelcome } from './version.js';
import { protocolVersionSchema } from './version.js';

export const requestEnvelopeSchema = z.object({
    protocolVersion: protocolVersionSchema,
    id: identifierSchema,
    method: z.string().refine(isCaxriMethod),
    params: z.unknown(),
});

export type CommandRequestEnvelope = z.infer<typeof requestEnvelopeSchema>;

/**
 * Validates params once and pairs them with their method so downstream `switch` statements narrow both together. The
 * assertion is the single correlation point: `methods[method]` is resolved from a value, which TypeScript cannot relate
 * back to the method literal on its own.
 */
export function parseCaxriRequest(method: CaxriMethod, parameters: unknown): CaxriRequest {
    return { method, params: methods[method].params.parse(parameters) } as CaxriRequest;
}

/**
 * Server-side equivalent that also accepts internal operations.
 */
export function parseServerOperationRequest(
    method: string,
    parameters: unknown,
): ServerOperationRequest {
    const spec = getMethodSpec(method);
    if (!spec) throw new CaxriError('VALIDATION', `Unknown Runtime method: ${method}`);
    return { method, params: spec.params.parse(parameters) } as ServerOperationRequest;
}

function invalidResult(method: string, issues: z.core.$ZodIssue[]): CaxriError {
    return new CaxriError('INTERNAL', `Invalid result returned for ${method}`, {
        issues: issues.slice(0, 5).map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
        })),
    });
}

/**
 * Validates a Desktop or Server result before it crosses the Renderer IPC boundary.
 */
export function parseCaxriResult<M extends CaxriMethod>(
    method: M,
    result: unknown,
): MethodResult<M> {
    const parsed = methods[method].result.safeParse(result);
    if (!parsed.success) throw invalidResult(method, parsed.error.issues);
    return parsed.data as MethodResult<M>;
}

/**
 * Validates a Server result, including internal operations.
 */
export function parseServerOperationResult<M extends ServerOperation>(
    method: M,
    result: unknown,
): ServerOperationResult<M> {
    const spec = getMethodSpec(method);
    if (!spec) throw new CaxriError('INTERNAL', `Unknown Runtime result method: ${method}`);
    const parsed = spec.result.safeParse(result);
    if (!parsed.success) throw invalidResult(method, parsed.error.issues);
    return parsed.data as ServerOperationResult<M>;
}

export const wireErrorSchema = z
    .object({
        code: z.unknown(),
        message: z.string().min(1),
        details: z.record(z.string(), z.unknown()).optional(),
    })
    .transform(({ code, message, details }): WireError => ({
        code: toErrorCode(code),
        message,
        ...(details && { details }),
    }));

/**
 * Server-attested context attached only to Extension workspace requests. It binds a request to the Workbench Root that
 * was selected when the public API call began; the domain layer rechecks the binding immediately before invoking a
 * handler so a same-Session root switch cannot redirect an in-flight operation.
 */
export const workbenchRequestContextSchema = z.object({
    sessionId: identifierSchema,
    workbenchRootProjectId: identifierSchema,
});

export type WorkbenchRequestContext = z.infer<typeof workbenchRequestContextSchema>;

/**
 * Main answers `caxri:request` with this envelope so the error code survives the Electron hop.
 */
export type CaxriReply = CommandReplyEnvelope;

export const commandReplyEnvelopeSchema = z.discriminatedUnion('ok', [
    z.object({
        protocolVersion: protocolVersionSchema,
        id: identifierSchema.nullable(),
        ok: z.literal(true),
        result: z.unknown(),
    }),
    z.object({
        protocolVersion: protocolVersionSchema,
        id: identifierSchema.nullable(),
        ok: z.literal(false),
        error: wireErrorSchema,
    }),
]);

export type CommandReplyEnvelope = z.infer<typeof commandReplyEnvelopeSchema>;

/**
 * The same envelope once the method table has resolved the result shape.
 */
export type MethodReply<M extends CaxriMethod> =
    | {
          protocolVersion: typeof CAXRI_PROTOCOL_VERSION;
          id: string;
          ok: true;
          result: MethodResult<M>;
      }
    | {
          protocolVersion: typeof CAXRI_PROTOCOL_VERSION;
          id: string;
          ok: false;
          error: WireError;
      };

/**
 * The preload allowlist. `request` resolves with a reply envelope instead of rejecting because Electron's
 * `contextBridge` copies only `message` and `stack` off a thrown Error: a `CaxriError` raised in the preload would
 * reach the Renderer as a plain `Error` with no `code`. The Renderer rebuilds the typed error through
 * {@link createCaxriClient}.
 */
export interface CaxriBridge {
    negotiate(): Promise<ProtocolWelcome>;
    request<M extends CaxriMethod>(
        method: M,
        ...arguments_: ParametersArgument<M>
    ): Promise<MethodReply<M>>;
    /**
     * Sends a request with caller-owned identity so the Renderer can cancel long-running Core reads without exposing an
     * AbortSignal across Electron's context bridge.
     */
    requestWithId<M extends CaxriMethod>(
        requestId: string,
        method: M,
        ...arguments_: ParametersArgument<M>
    ): Promise<MethodReply<M>>;
    onEvent(listener: (event: ServerEvent) => void): () => void;
    /**
     * Reports only a fault class; private exception values never cross the preload boundary.
     */
    reportError(kind: RendererErrorKind): void;
    /**
     * Reports a strict, content-free Renderer lifecycle snapshot for local diagnostics.
     */
    reportDiagnostic(diagnostic: RendererDiagnostic): void;
    /**
     * The disk path of a `File` the user dropped on the page, or `''` when it has none, such as a file promise not yet
     * written to disk. Electron removed `File.path`, and only a preload can call `webUtils.getPathForFile`. It reads no
     * file and resolves only `File` objects the user handed to the page.
     *
     * @see https://www.electronjs.org/docs/latest/api/web-utils#webutilsgetpathforfilefile
     */
    pathForFile(file: File): string;
}

/**
 * Renderer-facing view of the bridge: results are unwrapped and failures reject with `CaxriError`.
 */
export interface CaxriClient {
    negotiate(): Promise<ProtocolWelcome>;
    request<M extends CaxriMethod>(
        method: M,
        ...arguments_: ParametersArgument<M>
    ): Promise<MethodResult<M>>;
    requestWithSignal<M extends CaxriMethod>(
        method: M,
        signal: AbortSignal,
        ...arguments_: ParametersArgument<M>
    ): Promise<MethodResult<M>>;
    onEvent(listener: (event: ServerEvent) => void): () => void;
}

export function createCaxriClient(
    bridge: Pick<CaxriBridge, 'negotiate' | 'request' | 'requestWithId' | 'onEvent'>,
): CaxriClient {
    function unwrap<M extends CaxriMethod>(
        method: M,
        reply: CommandReplyEnvelope,
    ): MethodResult<M> {
        if (!reply.ok) throw fromWireError(reply.error);
        return parseCaxriResult(method, reply.result);
    }

    async function request<M extends CaxriMethod>(
        method: M,
        ...arguments_: ParametersArgument<M>
    ): Promise<MethodResult<M>> {
        const reply = commandReplyEnvelopeSchema.parse(await bridge.request(method, ...arguments_));
        return unwrap(method, reply);
    }

    async function requestWithSignal<M extends CaxriMethod>(
        method: M,
        signal: AbortSignal,
        ...arguments_: ParametersArgument<M>
    ): Promise<MethodResult<M>> {
        if (signal.aborted) throw new CaxriError('CANCELLED', 'Request was canceled');
        const requestId = crypto.randomUUID();
        const cancel = (): void => {
            // Cancellation is best-effort because the authoritative request reply owns the caller-visible result.
            void bridge.request('requests.cancel', { requestId }).catch(() => {});
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
            const reply = commandReplyEnvelopeSchema.parse(
                await bridge.requestWithId(requestId, method, ...arguments_),
            );
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal may abort while the bridge request is awaited
            if (signal.aborted) throw new CaxriError('CANCELLED', 'Request was canceled');
            return unwrap(method, reply);
        } finally {
            signal.removeEventListener('abort', cancel);
        }
    }
    return {
        negotiate: () => bridge.negotiate(),
        request,
        requestWithSignal,
        onEvent: (listener) => bridge.onEvent(listener),
    };
}
