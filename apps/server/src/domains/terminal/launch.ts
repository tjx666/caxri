import { constants } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';

import type { AgentLaunchSettings, TerminalKind } from '@caxri/protocol';
import { agentProviderCatalog, CaxriError } from '@caxri/protocol';
import { accountShell, isAccessible, preferredShell, systemShellCandidates } from '@caxri/system';

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

/**
 * `SHELL` is inherited from the login session, so it can outlive the shell it names (an uninstalled Homebrew fish or
 * bash). Falling back to the account's login shell and then the platform's system shells keeps the Terminal usable;
 * failing only when none runs lets the launch report a named missing shell instead of a generic spawn failure.
 */
async function resolveShellExecutable(configured: string): Promise<string> {
    if (await isAccessible(configured, constants.X_OK)) return configured;
    const fallbacks = [accountShell(), ...systemShellCandidates()].filter(
        (candidate): candidate is string => candidate !== undefined && candidate !== configured,
    );
    for (const candidate of fallbacks) {
        // Ordered fallback: the first runnable shell wins, so the probes stay sequential.
        // eslint-disable-next-line no-await-in-loop -- ordered fallback, see comment above
        if (await isAccessible(candidate, constants.X_OK)) return candidate;
    }
    throw new CaxriError('UNAVAILABLE', `Shell ${configured} was not found`, {
        reason: 'shell_not_found',
    });
}

export async function resolveTerminalExecutable(
    kind: TerminalKind,
    launchSettings: AgentLaunchSettings | undefined,
    override: TerminalManagerOptions['resolveExecutable'],
): Promise<string> {
    if (override) return override(kind, launchSettings);
    if (kind === 'shell') return resolveShellExecutable(preferredShell());
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
