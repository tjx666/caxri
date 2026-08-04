import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Relaunch a TypeScript probe under Electron while keeping Bun as the public script entry point. */
export async function runInElectron(scriptUrl: string): Promise<boolean> {
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
