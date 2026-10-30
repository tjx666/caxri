/**
 * Pure field construction for mirrored Renderer `console-message` errors. Kept free of Electron imports so the
 * classification contract is unit testable and the wiring in `index.ts` / `window.ts` stays a thin caller.
 *
 * The console text itself is never logged. This is the one log field in the app that no call site controls: it forwards
 * whatever any Renderer code (Monaco, xterm, React internals, a third-party module) happened to print at error level,
 * and `desktop.jsonl` is copied verbatim into the diagnostics export, returned by `logs.query`, and collected as an E2E
 * artifact. The structured logger's redaction is a credential-shape matcher (`sk-`, `Bearer`, `ghp_`, `key=value`, the
 * home directory); it cannot recognize source text, Terminal output, or an Agent transcript, so it is not a
 * classification boundary. Diagnostics must exclude all of those, so the record carries a bounded description instead:
 * which error class, from which module, how large, and a stable identity for deduplicating repeats.
 */

import { createHash } from 'node:crypto';

/**
 * Error constructor names the classifier reports. A closed set on purpose: a name read out of untrusted console text is
 * only safe to log because it has to match one of these, and anything else becomes `Unknown`.
 */
const ERROR_NAMES = new Set([
    'AggregateError',
    'DOMException',
    'ErrorEvent',
    'EvalError',
    'Error',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'TypeError',
    'URIError',
]);

/**
 * Hex characters kept from the message digest. Twelve is far past collision range for the handful of distinct faults
 * one session produces, and short enough to read in a log line.
 */
const MESSAGE_ID_LENGTH = 12;

export interface ConsoleErrorDetails {
    message: string;
    sourceId?: string;
    lineNumber?: number;
}

function errorNameOf(message: string): string {
    const firstLine = message.slice(0, message.indexOf('\n') + 1 || undefined);
    /**
     * `[A-Za-z]*` rather than `+`: a bare `Error:` is the most common Renderer fault of all, and requiring a prefix
     * made both it and `ErrorEvent` unreachable members of the closed set below.
     */
    const match = /\b([A-Za-z]*Error(?:Event)?|DOMException)\b/.exec(firstLine);
    return match && ERROR_NAMES.has(match[1]) ? match[1] : 'Unknown';
}

/**
 * Lines after the first. A JavaScript stack and a React component stack both arrive as trailing indented lines, so the
 * count separates a bare one-line log from a crash that carried its call path without reproducing either.
 */
function stackLineCount(message: string): number {
    let count = 0;
    for (const line of message.split('\n').slice(1)) {
        if (line.trim().length > 0) count += 1;
    }
    return count;
}

/**
 * Builds the log fields for one mirrored console error. Every value is derived from the message; none of it is the
 * message.
 *
 * @param details Chromium's `console-message` payload for an error-level record.
 */
export function consoleErrorLogFields(
    details: ConsoleErrorDetails,
): Record<string, string | number> {
    return {
        code: 'CONSOLE_ERROR',
        errorName: errorNameOf(details.message),
        /**
         * Stable across repeats of one fault and across runs, so a flapping error is recognizable as one identity
         * without keeping the text that produced it. The digest is one-way; the original is not recoverable from it.
         */
        messageId: createHash('sha256')
            .update(details.message)
            .digest('hex')
            .slice(0, MESSAGE_ID_LENGTH),
        messageLength: details.message.length,
        source: `${details.sourceId ?? '<unknown>'}:${details.lineNumber ?? 0}`,
        stackLines: stackLineCount(details.message),
    };
}
