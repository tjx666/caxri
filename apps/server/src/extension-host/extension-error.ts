import { AsyncLocalStorage } from 'node:async_hooks';

import type {
    FailureReason,
    LogRecord,
    ObservationOutcome,
    RemediationCategory,
} from '@caxri/system';

/**
 * The two outcomes `docs/extensions.md` defines as typed non-faults, for Source Control snapshots as well as Tree RPC.
 * They are the ordinary result of a Session switch, an extension reconfiguration, or an Extension Host restart racing a
 * request that is still in flight, and they reach this catch from every generation-checked path: `treeChildren`,
 * `activate`, `executeCommand`, `viewOperation`, and `workspace.*` calls alike. Neither may be reported as a fault that
 * recommends restarting a healthy Extension Host: an automated recovery path reading `remediation` would otherwise
 * restart the process on routine turnover.
 *
 * `CANCELLED` and `GENERATION_EXPIRED` are NOT reserved words of the Extension API (see `docs/extensions.md`): a
 * provider may throw either string as its own `code`. Matching this map is therefore necessary but not sufficient for
 * the non-fault classification: {@link extensionRequestFailureRecord} additionally requires the error to be
 * Caxri-originated, see {@link hostError}.
 */
const NON_FAULT_REASONS: ReadonlyMap<string, FailureReason> = new Map([
    ['CANCELLED', 'cancelled'],
    ['GENERATION_EXPIRED', 'generation-superseded'],
]);

/**
 * The private registry of Caxri-originated errors. An error thrown by extension code is ordinary data owned by that
 * extension: any property or well-known `Symbol.for` key placed on it could be read, copied, or forged by the same code
 * that threw it. A `WeakSet` keyed by object identity has no such surface: it is not a property on the error, not a
 * registry reachable through a well-known symbol, and not exposed on `globalThis`.
 *
 * Membership proves who minted an object, not who threw it: an extension does receive host-minted rejections from
 * `caxri.*` API calls and could re-throw one from its own provider. That is why {@link providerFailure} never lets an
 * object that crossed extension code keep its membership: it re-mints from host-owned request state instead.
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
 * The separate registry for the one non-fault an extension is allowed to assert about state the host cannot see.
 *
 * A provider's own model revision is extension-owned: the bundled Git extension bumps it on every refresh, and the host
 * has no way to corroborate that a request arrived against a stale one. Without this, the only honest classification
 * for that routine outcome was a `warn` fault recommending an Extension Host restart (issue #614).
 *
 * It is deliberately not merged into {@link hostOriginatedErrors}: membership there means "the host decided this", and
 * {@link providerFailure} strips it precisely because an extension can re-throw a host rejection. Membership here means
 * the narrower "the extension declared this one outcome", which survives the trip because declaring it is the point.
 * The factory mints only `GENERATION_EXPIRED` for exactly that reason: a general `nonFailureError(code)` would let an
 * extension downgrade any real failure, which is what issue #606 closed.
 */
const declaredSupersededErrors = new WeakSet<Error>();

/**
 * Mints the extension-declared "my own revision is superseded" non-fault. Reachable by extension code as
 * `caxri.supersededError(...)`; see `docs/extensions.md` for the trust contract it carries.
 */
export function supersededError(message: string): Error {
    const error = Object.assign(new Error(message), { code: 'GENERATION_EXPIRED' });
    declaredSupersededErrors.add(error);
    return error;
}

/**
 * Host-private ledger of what the host itself did to the `caxri.*` API calls one provider request issued. A provider
 * that awaits `workspace.git.summary(...)` or `workspace.getProjectStatus(...)` receives Server Core's own
 * `GENERATION_EXPIRED` when the request's Session scope changes mid-read, and the bundled providers let that rejection
 * propagate unchanged. The boundary cannot tell that outcome from a provider-forged code by looking at the error
 * object, so the API layer records the host's decision here, keyed to the request through `AsyncLocalStorage` rather
 * than through anything the extension can reach.
 *
 * A `CANCELLED` is recorded only when it arrives in Server Core's own reply: the controlled-view scope fence rejects a
 * `workspace.request` whose Session scope is no longer current with that code, and never when it follows the token the
 * extension passed to the call, which may be the extension's own `CancellationTokenSource`. When that token is the
 * host's request token, {@link HostRequestState.cancelled} already corroborates it.
 */
export interface ProviderRequestScope {
    /**
     * Server Core rejected at least one API call this request issued with `CANCELLED` on its own initiative.
     */
    hostCancelledApiCall: boolean;
    /**
     * Server Core or the Extension Host generation check expired at least one API call this request issued.
     */
    hostExpiredApiCall: boolean;
}

const providerRequestScope = new AsyncLocalStorage<ProviderRequestScope>();

export function createProviderRequestScope(): ProviderRequestScope {
    return { hostCancelledApiCall: false, hostExpiredApiCall: false };
}

/**
 * Runs one provider call so that every `caxri.*` API request it issues, directly or through awaited continuations, can
 * be attributed back to `scope` by {@link recordHostApiRejection}.
 */
export function withProviderRequestScope<Result>(
    scope: ProviderRequestScope,
    callback: () => Result,
): Result {
    return providerRequestScope.run(scope, callback);
}

export function currentProviderRequestScope(): ProviderRequestScope | undefined {
    return providerRequestScope.getStore();
}

/**
 * Marks the owning provider request when the host itself rejects one of its API calls with a non-fault code. Called by
 * the API request layer with the scope captured when the call was issued, so a rejection delivered from the IPC message
 * handler still lands on the right request. The caller decides whether a rejection was the host's own decision; see
 * {@link ProviderRequestScope} for the `CANCELLED` rule.
 */
export function recordHostApiRejection(
    scope: ProviderRequestScope | undefined,
    code: string,
): void {
    if (!scope) return;
    if (code === 'CANCELLED') scope.hostCancelledApiCall = true;
    else if (code === 'GENERATION_EXPIRED') scope.hostExpiredApiCall = true;
}

/**
 * What the host itself knows about the request whose provider call just failed. Every fact comes from host-owned state:
 * the request's own `CancellationTokenSource`, the provider/instance registration, and the {@link ProviderRequestScope}
 * the API layer wrote to: never from the error object.
 */
export interface HostRequestState {
    /**
     * The host cancelled this request through its own token before or while the provider was running.
     */
    cancelled: boolean;
    /**
     * The extension instance this request was issued against is no longer current. Only host-driven turnover counts. A
     * tree provider's own refresh epoch and a provider's or command's own registration identity are deliberately NOT
     * part of this: the extension fires that refresh and owns that registration's Disposable, so either could
     * manufacture the corroboration for a forged `GENERATION_EXPIRED`. The host still expires a request that returns
     * normally after its own refresh through `assertRefreshCurrent`, minted as host-originated there.
     */
    generationExpired: boolean;
    /**
     * The API calls this request issued; see {@link ProviderRequestScope}.
     */
    scope: ProviderRequestScope;
}

function readErrorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
}

/**
 * Normalizes a failure that crossed extension code (a provider call, a contributed command, or `activate()`) into a
 * fresh host-owned error.
 *
 * The returned object is always new, so any `hostError` membership the extension may have obtained (for example by
 * re-throwing a rejection it received from a `caxri.*` API call) never survives the trip. The non-fault codes are
 * re-minted as host-originated only when host state proves the outcome:
 *
 * - The bundled Git extension's own `assertNotCancelled` throws its own `CANCELLED` after the host cancelled the request
 *   (issue #587's Source Control Session-switch records);
 * - A provider registration or extension instance turned over while the extension code was running;
 * - Server Core cancelled or expired an API call the extension awaited (a Session switch mid-`git.summary`), which the
 *   bundled providers propagate unchanged and which is recorded in the request's {@link ProviderRequestScope}.
 *
 * Each of those is the host's decision reported back, not an extension fault. A `CANCELLED` or `GENERATION_EXPIRED` the
 * host cannot corroborate stays a fault, so extension code cannot silence a real failure by choosing the code (issue
 * #606). The one exception is an object minted by {@link supersededError}, which is the extension declaring the single
 * outcome only it can see: that a request arrived against its own stale model revision (issue #614). Object identity,
 * not the code string, is what separates it from a forged `GENERATION_EXPIRED`. `fallbackCode` keeps each boundary's
 * existing wire code for an uncoded failure.
 */
export function providerFailure(
    error: unknown,
    host: HostRequestState,
    fallbackMessage: string,
    fallbackCode = 'PROVIDER_FAILED',
): Error {
    const code = readErrorCode(error);
    // A thrown string (`throw 'Cannot find module x'`) still carries the only description that crosses the wire.
    const message =
        (error instanceof Error ? error.message : typeof error === 'string' ? error : '') ||
        fallbackMessage;
    if (code === 'CANCELLED' && (host.cancelled || host.scope.hostCancelledApiCall))
        return hostError(code, message);
    if (
        code === 'GENERATION_EXPIRED' &&
        (host.generationExpired ||
            host.scope.hostExpiredApiCall ||
            (error instanceof Error && declaredSupersededErrors.has(error)))
    )
        return hostError(code, message);
    return Object.assign(new Error(message), { code: code ?? fallbackCode });
}

/**
 * Runs extension code (a provider call, a contributed command, or `activate()`) inside `scope` and normalizes any
 * failure through {@link providerFailure}. `hostState` is read at catch time so turnover that happened while the
 * extension code was running still corroborates. Pass a shared `scope` when several calls belong to one request.
 */
export async function runExtensionCode<Result>(
    call: () => Promise<Result> | Result,
    hostState: () => Omit<HostRequestState, 'scope'>,
    fallback: { message: string; code?: string },
    scope = createProviderRequestScope(),
): Promise<Result> {
    try {
        return await withProviderRequestScope(scope, call);
    } catch (error) {
        throw providerFailure(error, { ...hostState(), scope }, fallback.message, fallback.code);
    }
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
    outcome: Extract<ObservationOutcome, 'cancelled' | 'failure' | 'superseded'>;
    writeToLog: boolean;
}

/**
 * Classifies a failed Extension Host request for diagnostics. Cancellation and generation turnover are frequent,
 * expected non-faults, so they remain visible through the bounded request metric without consuming one durable record
 * per request. Real failures keep their `warn` record and fault shape.
 *
 * The non-fault classification requires BOTH a matching code in {@link NON_FAULT_REASONS} AND
 * `isHostOriginatedError(error)`. An extension provider can throw `Object.assign(new Error('boom'), { code: 'CANCELLED'
 * })` and reuse the exact same code string, but only an error minted through {@link hostError} is Caxri-originated.
 * Origin for a failure that crossed a provider call is never the throwing code's: {@link providerFailure} establishes it
 * from host-owned request state, so a provider-thrown code is a non-fault only when the host corroborates the outcome
 * and a real fault otherwise (issue #606).
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
            outcome: nonFaultReason === 'cancelled' ? 'cancelled' : 'superseded',
            writeToLog: false,
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
        outcome: 'failure',
        writeToLog: true,
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
