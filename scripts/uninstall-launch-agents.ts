import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from './exec';

/**
 * Must match `CLAUDE_WINDOW_JOB_LABEL_PREFIX` in `apps/desktop/src/main/claude-windows/launch-agent.ts`: the launchd
 * jobs Desktop registers for the Claude 5-hour window keeper, one per profile.
 */
const CAXRI_LAUNCH_AGENT_PREFIX = 'com.caxri.app.claude-windows.';

/**
 * The Caxri launchd job files in `~/Library/LaunchAgents`, which the uninstall plan archives with the profiles.
 */
export async function discoverCaxriLaunchAgents(homeDirectory: string): Promise<string[]> {
    const directory = join(homeDirectory, 'Library', 'LaunchAgents');
    let names: string[];
    try {
        names = await readdir(directory);
    } catch {
        return [];
    }
    return names
        .filter((name) => name.startsWith(CAXRI_LAUNCH_AGENT_PREFIX) && name.endsWith('.plist'))
        .map((name) => join(directory, name));
}

/**
 * Unloads each Caxri launchd job among the targets before its file is archived; otherwise the loaded job keeps running
 * until logout and would start a Host on a fresh, empty profile. A job that is not loaded is fine.
 */
export async function unloadCaxriLaunchAgents(
    targets: readonly string[],
    run: (arguments_: string[]) => Promise<unknown> = (arguments_) =>
        execFileAsync('/bin/launchctl', arguments_, { timeout: 10_000 }),
): Promise<void> {
    const uid = process.getuid?.() ?? 0;
    for (const target of targets) {
        const name = basename(target);
        if (!name.startsWith(CAXRI_LAUNCH_AGENT_PREFIX) || !name.endsWith('.plist')) continue;
        try {
            // eslint-disable-next-line no-await-in-loop -- one launchctl call per job, in plan order
            await run(['bootout', `gui/${uid}/${name.slice(0, -'.plist'.length)}`]);
        } catch {
            // A job that is not loaded has nothing to unload.
        }
    }
}
