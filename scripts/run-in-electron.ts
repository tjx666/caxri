import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { execFileAsync } from './exec';

/**
 * Relaunch a TypeScript probe under Electron while keeping Bun as the public script entry point.
 */
export async function didRelaunchInElectron(scriptUrl: string): Promise<boolean> {
    if (process.versions.electron) return false;
    const electronPath: unknown = (await import('electron')).default;
    if (typeof electronPath !== 'string')
        throw new Error('Electron executable path is unavailable');
    const { stderr, stdout } = await execFileAsync(electronPath, [fileURLToPath(scriptUrl)], {
        timeout: 15_000,
    });
    if (stderr) process.stderr.write(stderr);
    process.stdout.write(stdout);
    return true;
}
