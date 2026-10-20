import type { SshHostFailureReason } from '@caxri/protocol';
import { CaxriError, errorMessage } from '@caxri/protocol';

import type { SshHostScript } from './scripts';
import { parseSshHostResult } from './scripts';
import type { SshConnectionCloseInfo, SshExecOptions, SshExecResult } from './ssh-connection';
import { SshConnectionError } from './ssh-connection';

/**
 * The transport surface the supervisor needs; `SshConnection` in production and a local fake in tests.
 */
export interface SshHostTransport {
    readonly isOpen: boolean;
    cancelForward(localPort: number): Promise<void>;
    exec(script: string, options: SshExecOptions): Promise<SshExecResult>;
    forwardLocal(remotePort: number): Promise<number>;
    onClose(listener: (info: SshConnectionCloseInfo) => void): () => void;
    start(): Promise<void>;
    stop(): Promise<void>;
}

/**
 * Failures that retrying cannot fix: they stop `DesktopServerConnection`'s reconnect loop (via `isFailed`) until the
 * user chooses Reconnect. Only `authentication` and `hostKey` also report `needsUserAction`, because only those are
 * resolved by answering a prompt.
 */
export const TERMINAL_REASONS: ReadonlySet<SshHostFailureReason> = new Set([
    'authentication',
    'hostKey',
    'unsupportedPlatform',
    'unsupportedGlibc',
    'missingTool',
    'installFailed',
    'profileInUse',
    'cancelled',
]);
export const USER_ACTION_REASONS: ReadonlySet<SshHostFailureReason> = new Set([
    'authentication',
    'hostKey',
]);
export const CANCELLED_FAILURE = { reason: 'cancelled', message: 'Connection cancelled' } as const;

/**
 * A failure classified into the protocol's closed reason. Thrown to `DesktopServerConnection` as a `CaxriError` so its
 * logging and retry paths stay unchanged.
 */
export class SshHostSetupError extends CaxriError {
    constructor(
        readonly reason: SshHostFailureReason,
        message: string,
        /**
         * For `profileInUse`: the hostname of the machine whose Server holds the shared profile.
         */
        readonly holder?: string,
    ) {
        super('UNAVAILABLE', message, { reason });
    }
}

export interface SshHostFailure {
    message: string;
    reason: SshHostFailureReason;
    holder?: string;
}

export type ScriptOutput = SshExecResult & { result?: Map<string, string> };

/**
 * Runs one remote script over the transport and parses its marker-delimited result block.
 */
export async function runSshHostScript(
    connection: SshHostTransport,
    script: SshHostScript,
    options: SshExecOptions,
): Promise<ScriptOutput> {
    const output = await connection.exec(script.script, options);
    return { ...output, result: parseSshHostResult(output.stdout, script.marker) };
}

export function toFailure(error: unknown): SshHostFailure {
    if (error instanceof SshHostSetupError)
        return {
            message: error.message.slice(0, 2000),
            reason: error.reason,
            ...(error.holder !== undefined && { holder: error.holder.slice(0, 255) }),
        };
    if (error instanceof SshConnectionError)
        return { message: error.message.slice(0, 2000), reason: error.reason };
    return { message: errorMessage(error, 'Unknown error').slice(0, 2000), reason: 'unknown' };
}

/**
 * The line that says why a remote Server failed to start: the last uncaught error header (`CaxriError: A Host already
 * owns this profile`) rather than the `Node.js vX` line Node prints after the stack. Falls back to the last line for
 * output that is not a Node crash.
 */
export function launchFailureDetail(text: string): string {
    const header = text
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .findLast((line) => /^(?:[A-Z]\w*)?Error(?: \[\w+\])?: \S/u.test(line));
    return header?.slice(0, 2000) ?? lastLine(text);
}

export function lastLine(text: string): string {
    return (
        text
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .findLast((line) => line !== '') ?? ''
    ).slice(0, 2000);
}

/**
 * Runs a best-effort remote step whose failure must not fail the attach (cleanup, config seeding, forward
 * cancellation).
 */
export async function bestEffort(task: () => Promise<unknown>): Promise<void> {
    try {
        await task();
    } catch {
        // Intentionally ignored; see the call site.
    }
}
