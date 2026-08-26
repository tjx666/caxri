import type { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { internalMethods, methods } from './method-registry.js';

export type CaxriMethod = keyof typeof methods;
type InternalMethod = keyof typeof internalMethods;
export type ServerOperation = CaxriMethod | InternalMethod;

type DesktopMethod = {
    [M in CaxriMethod]: Extract<(typeof methods)[M]['owner'], 'desktop'> extends never ? never : M;
}[CaxriMethod];

export type HostMethod = {
    [M in CaxriMethod]: Extract<(typeof methods)[M]['owner'], 'host'> extends never ? never : M;
}[CaxriMethod];

type AllMethods = typeof methods & typeof internalMethods;

/**
 * Parameters as a handler receives them, after Zod applied defaults and coercion.
 */
type MethodParameters<M extends CaxriMethod> = z.infer<(typeof methods)[M]['params']>;
/**
 * Parameters as a caller supplies them; `undefined` is allowed when the schema has a default.
 */
type MethodInput<M extends CaxriMethod> = z.input<(typeof methods)[M]['params']>;
export type MethodResult<M extends CaxriMethod> = z.infer<(typeof methods)[M]['result']>;

export type ServerOperationParameters<M extends ServerOperation> = z.infer<AllMethods[M]['params']>;
type ServerOperationInput<M extends ServerOperation> = z.input<AllMethods[M]['params']>;
export type ServerOperationResult<M extends ServerOperation> = z.infer<AllMethods[M]['result']>;

/**
 * Makes the params argument optional exactly when the method's schema accepts `undefined`.
 */
export type ParametersArgument<M extends CaxriMethod> =
    undefined extends MethodInput<M> ? [params?: MethodInput<M>] : [params: MethodInput<M>];

export type ServerOperationArguments<M extends ServerOperation> =
    undefined extends ServerOperationInput<M>
        ? [params?: ServerOperationInput<M>, timeoutMs?: number]
        : [params: ServerOperationInput<M>, timeoutMs?: number];

/**
 * Discriminated request unions let a `switch` on `method` narrow `params` without a cast.
 */
export type CaxriRequest = {
    [M in CaxriMethod]: { method: M; params: MethodParameters<M> };
}[CaxriMethod];

export type DesktopRequest = Extract<CaxriRequest, { method: DesktopMethod }>;
export type HostRequest = Extract<CaxriRequest, { method: HostMethod }>;
/**
 * Compatibility name for the Electron Main adapter while ownership moves to the Host protocol.
 */
export type MainRequest = DesktopRequest;

export type ServerOperationRequest = {
    [M in ServerOperation]: { method: M; params: ServerOperationParameters<M> };
}[ServerOperation];

export function isCaxriMethod(value: string): value is CaxriMethod {
    return Object.hasOwn(methods, value);
}

/**
 * Narrows a validated public request to the Main-owned portion of the method table.
 */
export function isDesktopRequest(request: CaxriRequest): request is DesktopRequest {
    return methods[request.method].owner === 'desktop';
}

/**
 * Narrows a validated public request to the Host-owned portion of the method table.
 */
export function isHostRequest(request: CaxriRequest): request is HostRequest {
    return methods[request.method].owner === 'host';
}

/**
 * Compatibility guard used by the current Electron adapter.
 */
export function isMainRequest(request: CaxriRequest): request is MainRequest {
    return isDesktopRequest(request);
}

function isInternalMethod(value: string): value is InternalMethod {
    return Object.hasOwn(internalMethods, value);
}

export function getMethodSpec(method: string): MethodSpec | undefined {
    if (isCaxriMethod(method)) return methods[method];
    if (isInternalMethod(method)) return internalMethods[method];
    return undefined;
}
