import process from 'node:process';
import { fileURLToPath } from 'node:url';

// The explicit `.ts` extension is required: this module is re-executed under Electron's built-in
// Node (type-stripping ESM), which rejects extensionless specifiers that Bun resolves fine.
import { execFileAsync } from './exec.ts';

/**
 * Relaunch a TypeScript probe under Electron while keeping Bun as the public script entry point.
 */
export async function didRelaunchInElectron(
    scriptUrl: string,
    options: { args?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<boolean> {
    if (process.versions.electron) return false;
    const electronPath: unknown = (await import('electron')).default;
    if (typeof electronPath !== 'string')
        throw new Error('Electron executable path is unavailable');
    const { stderr, stdout } = await execFileAsync(
        electronPath,
        [fileURLToPath(scriptUrl), ...(options.args ?? [])],
        { env: options.env, timeout: options.timeoutMs ?? 15_000 },
    );
    if (stderr) process.stderr.write(stderr);
    process.stdout.write(stdout);
    return true;
}
