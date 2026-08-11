import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

export const runtimeStateSchema = z.object({
    cdpUrl: z.string(),
    electronIdentity: z.string().min(1).nullable(),
    electronPid: z.number().int().positive().nullable(),
    launcherIdentity: z.string().min(1),
    launcherPid: z.number().int().positive(),
    ownedUserData: z.boolean(),
    port: z.number().int().min(1024).max(65_535),
    startedAt: z.string(),
    testRootPath: z.string(),
    testRootPaths: z.array(z.string()).min(1).optional(),
    userDataDir: z.string(),
});

export type RuntimeState = z.infer<typeof runtimeStateSchema>;

export function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
}

export function isAlive(pid: number | null | undefined): boolean {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        if (errorCode(error) === 'EPERM') return false;
        if (errorCode(error) === 'ESRCH') return false;
        throw error;
    }
}

/**
 * Combines immutable process start time and command text so a recycled PID
 * cannot be mistaken for the Acceptance launcher that wrote runtime.json.
 */
export async function getProcessIdentity(pid: number): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync('ps', [
            '-ww',
            '-p',
            String(pid),
            '-o',
            'lstart=',
            '-o',
            'command=',
        ]);
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

export async function isOwnedLauncher(
    runtime: Pick<RuntimeState, 'launcherIdentity' | 'launcherPid'>,
): Promise<boolean> {
    return (await getProcessIdentity(runtime.launcherPid)) === runtime.launcherIdentity;
}

/** An isolated Acceptance instance remains owned while either supervised process is alive. */
export async function isOwnedRuntime(
    runtime: Pick<
        RuntimeState,
        'electronIdentity' | 'electronPid' | 'launcherIdentity' | 'launcherPid'
    >,
): Promise<boolean> {
    if (await isOwnedLauncher(runtime)) return true;
    return Boolean(
        runtime.electronPid &&
        runtime.electronIdentity &&
        (await getProcessIdentity(runtime.electronPid)) === runtime.electronIdentity,
    );
}

export async function removeOwnedUserData(
    runtime: Pick<RuntimeState, 'ownedUserData' | 'userDataDir'>,
): Promise<void> {
    const safePrefix = `${resolve(tmpdir())}${sep}caxri-acceptance-user-`;
    if (runtime.ownedUserData && resolve(runtime.userDataDir).startsWith(safePrefix)) {
        await rm(runtime.userDataDir, { force: true, recursive: true });
    }
}
