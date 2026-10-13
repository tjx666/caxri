import type { Buffer } from 'node:buffer';
import process from 'node:process';
import { PassThrough } from 'node:stream';

import type { SshConnectionOptions } from '../../ssh-connection';
import { SshConnection } from '../../ssh-connection';

/**
 * The opt-in real-`sshd` lab shared by the SSH integration suites. See `docs/remote-ssh.md#testing`.
 */
export const isSshIntegrationEnabled = process.env.CAXRI_SSH_INTEGRATION === '1';
/**
 * `-F` file that keeps the lab's keys and hosts away from the developer's own `~/.ssh`.
 */
export const labConfigFile = process.env.CAXRI_SSH_CONFIG;
/**
 * Lab host to drive; may sit behind a `ProxyJump`.
 */
export const labDestination = process.env.CAXRI_SSH_DESTINATION ?? 'caxri-lab';

/**
 * Stops the Server recorded in the lab account's manifest and deletes `~/.caxri-server` plus the suite's scratch
 * Project folder, so every run starts from a clean host.
 */
export function resetRemoteServerScript(projectFolder: string): string {
    return String.raw`pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$HOME/.caxri-server/profile/host/manifest.json" 2>/dev/null | head -n 1)
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
fi
rm -rf "$HOME/.caxri-server" "$HOME/${projectFolder}"
`;
}

/**
 * An `SshConnection` that reports every byte written to remote stdin (uploads), so "what travelled to the host" is
 * measured rather than inferred.
 */
export function createCountingConnection(
    options: SshConnectionOptions,
    onBytes: (count: number) => void,
): SshConnection {
    const connection = new SshConnection(options);
    const exec = connection.exec.bind(connection);
    connection.exec = (script, execOptions) => {
        if (!execOptions.stdin) return exec(script, execOptions);
        const counter = new PassThrough();
        counter.on('data', (chunk: Buffer) => onBytes(chunk.length));
        execOptions.stdin.on('error', (error) => counter.destroy(error));
        return exec(script, { ...execOptions, stdin: execOptions.stdin.pipe(counter) });
    };
    return connection;
}
