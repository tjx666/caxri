import { join } from 'node:path';

/**
 * Resolves the userData directory for this launch.
 *
 * Electron keys userData by application name alone (`~/Library/Application Support/caxri` on macOS), so an unpackaged
 * dev launch and the installed production app would otherwise share one profile — and because the Host socket derives
 * from `sha256(realpath(userData))`, they would also share one Host process and evict each other's Desktop lease. Dev
 * therefore defaults to a sibling `caxri-dev` profile; an explicit `CAXRI_USER_DATA_DIR` (worktree launcher, E2E,
 * acceptance) always wins so those flows keep their per-instance isolation.
 */
export function resolveUserDataPath(options: {
    appDataPath: string;
    environmentOverride?: string;
    isPackaged: boolean;
}): string | undefined {
    if (options.environmentOverride) return options.environmentOverride;
    if (!options.isPackaged) return join(options.appDataPath, 'caxri-dev');
    return undefined;
}
