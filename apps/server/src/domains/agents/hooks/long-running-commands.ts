import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { atomicWrite } from '../../atomic-file';

/**
 * Names the file the hook bridge reads `agents.longRunningShellCommands` from. The bridge matches a background shell's
 * command locally, so command text never reaches Server Core, and the bridge is shared by every Caxri build while this
 * file belongs to one profile.
 */
const LONG_RUNNING_COMMANDS_ENV = 'CAXRI_HOOK_LONG_RUNNING_COMMANDS';

/**
 * The profile-owned copy of `agents.longRunningShellCommands` that Claude Code hook launches point the bridge at.
 */
export function longRunningCommandsPath(userDataPath: string): string {
    return join(userDataPath, 'agent-hooks', 'long-running-shell-commands.json');
}

/**
 * Replaces the bridge's copy of the patterns. A bridge reads it once per `Stop`, so a settings change reaches running
 * Sessions on their next finish without relaunching them.
 */
export async function writeLongRunningCommands(
    path: string,
    patterns: readonly string[],
): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWrite(path, `${JSON.stringify(patterns)}\n`);
}

/**
 * Points a hook-enabled launch's bridge at the pattern file. A launch without hook credentials runs no bridge and is
 * returned unchanged.
 */
export function withLongRunningCommands(
    environment: NodeJS.ProcessEnv,
    path: string,
): NodeJS.ProcessEnv {
    return environment.CAXRI_HOOK_TOKEN
        ? { ...environment, [LONG_RUNNING_COMMANDS_ENV]: path }
        : environment;
}
