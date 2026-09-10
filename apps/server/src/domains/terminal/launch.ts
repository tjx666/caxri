import { lstat, realpath } from 'node:fs/promises';
import process from 'node:process';

import type { AgentLaunchSettings, TerminalKind } from '@caxri/protocol';
import { agentProviderCatalog, CaxriError } from '@caxri/protocol';

/**
 * Server domain boundaries require cross-domain dependencies to enter through the owning domain root.
 */
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { discoverExecutable } from '../agents';
import type { TerminalManagerOptions, TerminalWorkingDirectoryIdentity } from './manager-types';

/**
 * Captures the authorized directory identity for revalidation immediately before spawn.
 */
export async function terminalDirectoryIdentity(
    path: string,
): Promise<TerminalWorkingDirectoryIdentity> {
    const stats = await lstat(path, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory())
        throw new CaxriError('CONFLICT', 'Terminal working directory changed before launch');
    return { path, device: stats.dev.toString(), inode: stats.ino.toString() };
}

export async function resolveTerminalExecutable(
    kind: TerminalKind,
    launchSettings: AgentLaunchSettings | undefined,
    override: TerminalManagerOptions['resolveExecutable'],
): Promise<string> {
    if (override) return override(kind, launchSettings);
    /**
     * An empty `SHELL` is not runnable either, so this deliberately uses `||` instead of `??`.
     */
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string is not a valid shell path
    if (kind === 'shell') return process.env.SHELL || '/bin/zsh';
    const executable = await discoverExecutable(kind, launchSettings?.executable);
    if (!executable)
        throw new CaxriError(
            'UNAVAILABLE',
            `${agentProviderCatalog[kind].displayName} CLI was not found`,
        );
    return executable;
}

/**
 * Revalidates the authorized cwd immediately before the path-based node-pty spawn.
 */
export async function assertTerminalWorkingDirectory(
    path: string,
    expected?: TerminalWorkingDirectoryIdentity,
): Promise<void> {
    const [canonical, stats] = await Promise.all([realpath(path), lstat(path, { bigint: true })]);
    if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        (expected &&
            (canonical !== path ||
                expected.path !== path ||
                expected.device !== stats.dev.toString() ||
                expected.inode !== stats.ino.toString()))
    )
        throw new CaxriError('CONFLICT', 'Terminal working directory changed before launch');
}
