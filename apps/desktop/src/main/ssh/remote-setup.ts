import type { RemoteFailureReason } from '@caxri/protocol';
import { CaxriError, errorMessage } from '@caxri/protocol';

import type { RemoteScript } from './remote-scripts';
import { parseRemoteResult } from './remote-scripts';
import type { SshConnectionCloseInfo, SshExecOptions, SshExecResult } from './ssh-connection';
import { SshConnectionError } from './ssh-connection';

/**
 * The transport surface the supervisor needs; `SshConnection` in production and a local fake in tests.
 */
export interface RemoteTransport {
    readonly isOpen: boolean;
    cancelForward(localPort: number): Promise<void>;
    exec(script: string, options: SshExecOptions): Promise<SshExecResult>;
    forwardLocal(remotePort: number): Promise<number>;
    onClose(listener: (info: SshConnectionCloseInfo) => void): () => void;
    start(): Promise<void>;
    stop(): Promise<void>;
}

/**
 * A failure classified into the protocol's closed reason. Thrown to `DesktopServerConnection` as a `CaxriError` so its
 * logging and retry paths stay unchanged.
 */
export class RemoteSetupError extends CaxriError {
    constructor(
        readonly reason: RemoteFailureReason,
        message: string,
    ) {
        super('UNAVAILABLE', message, { reason });
    }
}

export type ScriptOutput = SshExecResult & { result?: Map<string, string> };

/**
 * Runs one remote script over the transport and parses its marker-delimited result block.
 */
export async function runRemoteScript(
    connection: RemoteTransport,
    script: RemoteScript,
    options: SshExecOptions,
): Promise<ScriptOutput> {
    const output = await connection.exec(script.script, options);
    return { ...output, result: parseRemoteResult(output.stdout, script.marker) };
}

export function toFailure(error: unknown): { message: string; reason: RemoteFailureReason } {
    if (error instanceof RemoteSetupError || error instanceof SshConnectionError)
        return { message: error.message.slice(0, 2000), reason: error.reason };
    return { message: errorMessage(error, 'Unknown error').slice(0, 2000), reason: 'unknown' };
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
