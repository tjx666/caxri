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
 * registry reachable through a well-known symbol, and not exposed on `globalThis`. An extension cannot observe, forge,
 * or clear membership no matter which `code` it sets on its own thrown error.
 */
const hostOriginatedErrors = new WeakSet<Error>();

/**
 * Mints a Caxri-originated error. This is the only way to produce an error that {@link isHostOriginatedError}
 * recognizes: every Extension Host site that raises `CANCELLED` / `GENERATION_EXPIRED` (or any other code) on the
 * host's own behalf must use it instead of `Object.assign(new Error(...), { code })`. Only origin, never the code
 * string, separates a Caxri-internal non-fault from an extension failure that reuses the same code (issue #606).
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
