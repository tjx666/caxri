import type { ProcessTable } from '@caxri/system';

export type KeychainPromptOutcome = 'allowed' | 'alwaysAllowed' | 'denied';

export type KeychainLogEvent =
    | { kind: 'shown'; pid: number }
    | { kind: 'resolved'; outcome: KeychainPromptOutcome; pid: number };

/**
 * Securityd's `kcacl` messages around a Keychain access dialog, as macOS 26 writes them:
 *
 * - `displaying keychain prompt for /path/to/node(58105); ACL: <...>`
 * - `user approved 'allow' for /path/to/node(58105)` or `user approved 'always allow' for ...`
 * - `user did not approve 'allow' for /path/to/node(58105): CssmError: ...`
 *
 * The path may itself contain parentheses, so the PID is the last `(<digits>)` before the end, a `;`, or a `:`.
 */
const SHOWN = /^displaying keychain prompt for .+\((\d+)\)(?:;|$)/;
const APPROVED = /^user approved '(allow|always allow)' for .+\((\d+)\)\s*$/;
const DENIED = /^user did not approve '[^']*' for .+\((\d+)\)(?::|$)/;

export function parseKeychainLogMessage(message: string): KeychainLogEvent | undefined {
    const shown = SHOWN.exec(message);
    if (shown) return { kind: 'shown', pid: Number(shown[1]) };
    const approved = APPROVED.exec(message);
    if (approved)
        return {
            kind: 'resolved',
            outcome: approved[1] === 'always allow' ? 'alwaysAllowed' : 'allowed',
            pid: Number(approved[2]),
        };
    const denied = DENIED.exec(message);
    if (denied) return { kind: 'resolved', outcome: 'denied', pid: Number(denied[1]) };
    return undefined;
}

/**
 * One `log stream --style ndjson` line. The stream opens with a plain-text "Filtering the log data ..." banner, and
 * anything else that is not an event object is skipped the same way.
 */
export function parseKeychainLogLine(line: string): KeychainLogEvent | undefined {
    if (!line.startsWith('{')) return undefined;
    let record: unknown;
    try {
        record = JSON.parse(line);
    } catch {
        return undefined;
    }
    if (typeof record !== 'object' || record === null) return undefined;
    const message = (record as { eventMessage?: unknown }).eventMessage;
    return typeof message === 'string' ? parseKeychainLogMessage(message) : undefined;
}

/**
 * Bounds the parent walk: a real chain is a dozen hops at most, and a corrupt table must not loop.
 */
const MAX_ANCESTRY_DEPTH = 64;

/**
 * The nearest ancestor of `pid` (itself included) that is one of `roots`, or `undefined` when the process does not
 * descend from anything Caxri started.
 */
export function findOwningRoot<T>(
    pid: number,
    table: Pick<ProcessTable, 'get'>,
    roots: ReadonlyMap<number, T>,
): T | undefined {
    let current: number | undefined = pid;
    for (
        let depth = 0;
        current !== undefined && current > 1 && depth < MAX_ANCESTRY_DEPTH;
        depth++
    ) {
        const owner = roots.get(current);
        if (owner !== undefined) return owner;
        current = table.get(current)?.parentPid;
    }
    return undefined;
}

const MAX_COMMAND_LENGTH = 240;

/**
 * The requester's command line as the row's tooltip shows it: the home directory folded to `~`, whitespace collapsed,
 * and cut to a readable length.
 */
export function displayCommand(command: string, homeDirectory: string): string {
    let text = command.replaceAll(/\s+/g, ' ').trim();
    if (homeDirectory.length > 1) text = text.replaceAll(homeDirectory, '~');
    return text.length > MAX_COMMAND_LENGTH ? `${text.slice(0, MAX_COMMAND_LENGTH - 1)}…` : text;
}
