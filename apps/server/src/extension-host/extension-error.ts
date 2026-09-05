import type { FailureReason, LogRecord, RemediationCategory } from '@caxri/system';

/**
 * The two outcomes `docs/extensions.md` defines as typed non-faults, for Source Control snapshots as well as Tree RPC.
 * They are the ordinary result of a Session switch, an extension reconfiguration, or an Extension Host restart racing a
 * request that is still in flight, and they reach this catch from every generation-checked path — `treeChildren`,
 * `activate`, `executeCommand`, `viewOperation`, and `workspace.*` calls alike. Neither may be reported as a fault that
 * recommends restarting a healthy Extension Host: an automated recovery path reading `remediation` would otherwise
 * restart the process on routine turnover.
 *
 * `CANCELLED` and `GENERATION_EXPIRED` are NOT reserved words of the Extension API (see `docs/extensions.md`): a
 * provider may throw either string as its own `code`. Matching this map is therefore necessary but not sufficient for
 * the non-fault classification — {@link extensionRequestFailureRecord} additionally requires the error to be
 * Caxri-originated, see {@link hostError}.
 */
const NON_FAULT_REASONS: ReadonlyMap<string, FailureReason> = new Map([
    ['CANCELLED', 'cancelled'],
    ['GENERATION_EXPIRED', 'generation-superseded'],
]);

/**
 * The private registry of Caxri-originated errors. An error thrown by extension code is ordinary data owned by that
 * extension: any property or well-known `Symbol.for` key placed on it could be read, copied, or forged by the same code
 * that threw it. A `WeakSet` keyed by object identity has no such surface — it is not a property on the error, not a
 * registry reachable through a well-known symbol, and not exposed on `globalThis`.
 *
 * Membership proves who minted an object, not who threw it: an extension does receive host-minted rejections from
 * `caxri.*` API calls and could re-throw one from its own provider. That is why {@link providerFailure} never lets an
 * object that crossed extension code keep its membership — it re-mints from host-owned request state instead.
 */
const hostOriginatedErrors = new WeakSet<Error>();

/**
 * Mints a Caxri-originated error. This is the only way to produce an error that {@link isHostOriginatedError}
 * recognizes, so every Extension Host site that raises one of the {@link NON_FAULT_REASONS} codes on the host's own
 * behalf must use it instead of `Object.assign(new Error(...), { code })`. Other host codes are faults either way and
 * intentionally stay unregistered. Only origin, never the code string, separates a Caxri-internal non-fault from an
 * extension failure that reuses the same code (issue #606).
 */
export function hostError(code: string, message: string): Error {
    const error = Object.assign(new Error(message), { code });
    hostOriginatedErrors.add(error);
    return error;
}

/**
 * Reports whether `error` was minted by {@link hostError}, i.e. is Caxri-originated rather than thrown by extension
 * code.
 */
export function isHostOriginatedError(error: unknown): boolean {
    return error instanceof Error && hostOriginatedErrors.has(error);
}

/**
 * What the host itself knows about the request whose provider call just failed. Both facts come from host-owned state
 * (the request's own `CancellationTokenSource`, the provider/instance registration and refresh epoch), never from the
 * error object.
 */
export interface HostRequestState {
    /**
     * The host cancelled this request through its own token before or while the provider was running.
     */
    cancelled: boolean;
    /**
     * The provider registration, extension instance, or refresh epoch this request was issued against is no longer
     * current.
     */
    generationExpired: boolean;
}

function readErrorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
}

/**
 * Normalizes a failure that crossed extension code (a provider call) into a fresh host-owned error.
 *
 * The returned object is always new, so any `hostError` membership the extension may have obtained — for example by
 * re-throwing a rejection it received from a `caxri.*` API call — never survives the trip. The non-fault codes are
 * re-minted as host-originated only when host state proves the outcome: the bundled Git extension's own
 * `assertNotCancelled` throws its own `CANCELLED` after the host cancelled the request (issue #587's Source Control
 * Session-switch records), and that is the host's decision reported back, not a provider fault. A `CANCELLED` or
 * `GENERATION_EXPIRED` the host cannot corroborate stays a fault, so a provider cannot silence a real failure by
 * choosing the code (issue #606).
 */
export function providerFailure(
    error: unknown,
    host: HostRequestState,
    fallbackMessage: string,
): Error {
    const code = readErrorCode(error);
    const message = error instanceof Error ? error.message : code ? String(error) : fallbackMessage;
    if (code === 'CANCELLED' && host.cancelled) return hostError(code, message);
    if (code === 'GENERATION_EXPIRED' && host.generationExpired) return hostError(code, message);
    return Object.assign(new Error(message), { code: code ?? 'PROVIDER_FAILED' });
}

export interface ExtensionRequestFailureRecord {
    failure: {
        code: string;
        owner: 'extension-host';
        phase: 'execute';
        reason: FailureReason;
        remediation: RemediationCategory;
        retryable: boolean;
    };
    level: LogRecord['level'];
}

/**
 * Classifies a failed Extension Host request for the diagnostic log. A non-fault drops to `debug` because cancellation
 * and generation turnover are frequent and expected; keeping them at `warn` spent the production log budget on records
 * that describe healthy behavior. Real failures keep the original `warn` level and fault shape.
 *
 * The non-fault classification requires BOTH a matching code in {@link NON_FAULT_REASONS} AND
 * `isHostOriginatedError(error)`. An extension provider can throw `Object.assign(new Error('boom'), { code: 'CANCELLED'
 * })` and reuse the exact same code string, but only an error minted through {@link hostError} is Caxri-originated — so
 * an extension-thrown error is always logged as a real fault regardless of its `code` (issue #606).
 */
export function extensionRequestFailureRecord(
    code: string,
    error: unknown,
): ExtensionRequestFailureRecord {
    const nonFaultReason = NON_FAULT_REASONS.get(code);
    if (nonFaultReason && isHostOriginatedError(error))
        return {
            failure: {
                code,
                owner: 'extension-host',
                phase: 'execute',
                reason: nonFaultReason,
                remediation: 'none',
                retryable: true,
            },
            level: 'debug',
        };
    return {
        failure: {
            code,
            owner: 'extension-host',
            phase: 'execute',
            reason: 'unknown',
            remediation: 'restart-extension-host',
            retryable: false,
        },
        level: 'warn',
    };
}

/**
 * Normalizes loader and provider failures into the stable Extension Host error taxonomy.
 */
export function extensionErrorShape(error: unknown): { code: string; message: string } {
    const rawCode =
        typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : undefined;
    const rawMessage = error instanceof Error ? error.message : String(error);
    const rawStableCode =
        [
            'ERR_PACKAGE_PATH_NOT_EXPORTED',
            'ERR_REQUIRE_ESM',
            'ERR_MODULE_NOT_FOUND',
            'MODULE_NOT_FOUND',
        ].includes(rawCode ?? '') && rawMessage.includes('caxri')
            ? 'COMMONJS_API_UNSUPPORTED'
            : (rawCode ?? 'ACTIVATION_FAILED');
    /**
     * Server Core treats oversized child messages as a compromised Extension Host. Normalize errors here so one noisy
     * provider cannot turn its local failure into a shared-host crash.
     */
    const code = rawStableCode.slice(0, 100) || 'ACTIVATION_FAILED';
    const message = rawMessage.slice(0, 2_048) || 'Extension failed without an error message';
    return { code, message };
}
