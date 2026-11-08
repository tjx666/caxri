import { createHash } from 'node:crypto';

/**
 * Hex characters kept from the message digest. Twelve is far past collision range for the handful of distinct faults
 * one session produces, and short enough to read in a log line.
 */
const MESSAGE_ID_LENGTH = 12;
/**
 * Shape of a value safe to log as a name or code: an identifier or an upper-case code, never prose.
 */
const NAME_PATTERN = /^[A-Z]\w{0,63}$/i;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Content-free description of a caught error for a structured log field.
 */
export interface ErrorLogFields {
    [key: string]: string | number;
    /**
     * Constructor-level class name (`Error`, `TypeError`, `CaxriError`); `Unknown` when absent or not
     * identifier-shaped.
     */
    errorName: string;
    /**
     * Node `code` (`ENOENT`) or `CaxriError` code when it is an upper-case identifier; `none` otherwise.
     */
    errorCode: string;
    /**
     * Length of the message text, so an empty fault is distinguishable from a verbose one.
     */
    errorMessageLength: number;
    /**
     * One-way digest of the message: repeats of one fault share an id without the text being recoverable.
     */
    errorMessageId: string;
}

/**
 * The call frames of an error's stack without its leading message lines. V8 renders `stack` as `Name: message` followed
 * by ` at ...` frames, so logging the raw stack copies the message (and any slug, ref, URL, or path it embeds) into the
 * bundle. The frames carry code locations only. `null` when there is no stack.
 */
export function errorStackFrames(error: unknown): string | null {
    if (!(error instanceof Error) || !error.stack) return null;
    const frames = error.stack.split('\n').filter((line) => /^\s+at\s/.test(line));
    return frames.length > 0 ? frames.join('\n') : null;
}

function readString(value: unknown, key: string): string | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const field: unknown = (value as Record<string, unknown>)[key];
    return typeof field === 'string' ? field : undefined;
}

/**
 * Turns an unknown thrown value into log-safe fields. Diagnostics bundles copy the JSONL logs verbatim, and the
 * logger's redaction only removes home paths and credential-shaped tokens: it leaves repository `owner/name` slugs,
 * branch names, URLs, non-home absolute paths, and stderr fragments that an error message routinely embeds. So a log
 * field never carries `error.message`, `errorMessage(error)`, `String(error)`, or `stderr`; it carries this derived
 * description instead. The `caxri/no-raw-error-text-in-logs` ESLint rule enforces the policy at every logger call.
 *
 * Spread the result into `fields`: `{ fields: { ...errorLogFields(error), terminalId } }`.
 */
export function errorLogFields(error: unknown): ErrorLogFields {
    const message =
        error instanceof Error ? error.message : (readString(error, 'message') ?? String(error));
    const name = error instanceof Error ? error.name : readString(error, 'name');
    const code = readString(error, 'code');
    return {
        errorName: name !== undefined && NAME_PATTERN.test(name) ? name : 'Unknown',
        errorCode: code !== undefined && CODE_PATTERN.test(code) ? code : 'none',
        errorMessageLength: message.length,
        errorMessageId: createHash('sha256')
            .update(message)
            .digest('hex')
            .slice(0, MESSAGE_ID_LENGTH),
    };
}
