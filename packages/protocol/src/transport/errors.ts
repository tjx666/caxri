import type { ZodError } from 'zod';

/**
 * Stable, cross-process error taxonomy. Every rejected Caxri request carries one of these codes so Main, the Renderer,
 * and tests can branch on classification instead of matching message strings.
 *
 * This module deliberately has no value-level imports. Electron's sandboxed preload can only `require` Electron
 * builtins and its own bundle, so pulling Zod (or any dependency) in here would break `window.caxri` at load time. The
 * Zod type import below is erased at build time.
 */
export const errorCodes = [
    'VALIDATION',
    'NOT_FOUND',
    'PATH_DENIED',
    'CAPACITY',
    'UNAVAILABLE',
    'TIMEOUT',
    'CANCELLED',
    'CONFLICT',
    'FORBIDDEN',
    'IO',
    'GIT',
    /**
     * The provider account reached Caxri's weekly usage guard; `details` carries `provider` and `resetsAt`. Only a
     * hand-off may still spend the account until the window resets.
     */
    'USAGE_LIMITED',
    'INTERNAL',
] as const;

export type CaxriErrorCode = (typeof errorCodes)[number];

export interface WireError {
    code: CaxriErrorCode;
    message: string;
    details?: Record<string, unknown>;
}

export class CaxriError extends Error {
    constructor(
        readonly code: CaxriErrorCode,
        message: string,
        readonly details?: Record<string, unknown>,
    ) {
        super(message);
        this.name = 'CaxriError';
    }
}

/**
 * Accepts equivalent instances emitted by another bundled copy of `@caxri/protocol`. Main embeds the source protocol
 * while the workspace CLI can load its built package, so `instanceof` alone would erase a Host reply code when those
 * copies meet at the Desktop adapter boundary.
 */
export function isCaxriError(value: unknown): value is CaxriError {
    if (value instanceof CaxriError) return true;
    if (!(value instanceof Error) || value.name !== 'CaxriError') return false;
    const candidate = value as Error & { code?: unknown; details?: unknown };
    const { code, details } = candidate;
    return (
        errorCodes.includes(code as CaxriErrorCode) &&
        (details === undefined ||
            (typeof details === 'object' && details !== null && !Array.isArray(details)))
    );
}

/**
 * Whether a rejection is a designed outcome the caller is expected to absorb rather than a Caxri defect.
 *
 * `CONFLICT` is the answer to a question the caller asked on purpose. `session.updateState` asks it as an
 * optimistic-concurrency check and re-derives its change against whichever write won; `file.move` asks it by trying
 * `conflict: 'reject'` first, precisely so a refusal can open the Finder-style Replace/Keep Both/Cancel dialog. Either
 * way the caller has a next move and the user sees the product working. Recording that at `error` would make ordinary
 * contention indistinguishable from a real fault, page as a production error beacon, and fail the E2E error gate. Every
 * boundary still logs it, one level lower, so its real volume stays visible.
 */
export function isCallerHandledFailure(code: string): boolean {
    return code === 'CONFLICT';
}

/**
 * Extracts a human-readable message from a caught value, falling back to a caller-supplied default for non-`Error`
 * throws (e.g. rejected primitives or `null`). Centralizes the `error instanceof Error ? error.message : fallback`
 * idiom repeated across every process.
 */
export function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}

/**
 * Unknown codes decay to `INTERNAL` so a newer Runtime can never break an older reader.
 */
export function toErrorCode(value: unknown): CaxriErrorCode {
    return errorCodes.includes(value as CaxriErrorCode) ? (value as CaxriErrorCode) : 'INTERNAL';
}

/**
 * Recognizes a Zod failure structurally rather than with `instanceof`. Keeping the check nominal would require
 * importing Zod at runtime, and it would also miss errors thrown by a second copy of Zod resolved elsewhere in the
 * dependency graph.
 */
function isZodError(value: unknown): value is ZodError {
    return (
        value instanceof Error &&
        value.name === 'ZodError' &&
        Array.isArray((value as { issues?: unknown }).issues)
    );
}

const MAX_REPORTED_ISSUES = 5;

/**
 * Renders a Zod failure as one readable sentence without echoing the rejected values.
 */
function describeValidationError(error: ZodError): string {
    const issues = error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
        const path = issue.path.join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
    });
    const overflow = error.issues.length - issues.length;
    return `Invalid request parameters (${issues.join('; ')}${overflow > 0 ? `; +${overflow} more` : ''})`;
}

/**
 * Classifies any thrown value for the wire. Zod failures become `VALIDATION`, `CaxriError` keeps its code, and anything
 * else is an unclassified `INTERNAL` fault.
 */
export function toWireError(error: unknown): WireError {
    if (isCaxriError(error)) {
        return error.details
            ? { code: error.code, message: error.message, details: error.details }
            : { code: error.code, message: error.message };
    }
    if (isZodError(error)) return { code: 'VALIDATION', message: describeValidationError(error) };
    return {
        code: 'INTERNAL',
        message: errorMessage(error, 'Unknown Caxri error'),
    };
}

/**
 * Rebuilds a `CaxriError` after a structured-clone hop erased the prototype and own properties.
 */
export function fromWireError(wire: unknown): CaxriError {
    if (typeof wire !== 'object' || wire === null)
        return new CaxriError('INTERNAL', 'Unknown Caxri error');
    // `wire` crosses a structured-clone hop from an untrusted process, so its shape is not guaranteed
    // to match `WireError` at runtime; read each field as `unknown` and re-validate defensively.
    const { code, message, details } = wire as Record<string, unknown>;
    return new CaxriError(
        toErrorCode(code),
        typeof message === 'string' && message ? message : 'Unknown Caxri error',
        typeof details === 'object' && details !== null
            ? (details as Record<string, unknown>)
            : undefined,
    );
}
