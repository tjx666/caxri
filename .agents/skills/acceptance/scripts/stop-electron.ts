import { readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { RuntimeState } from './runtime-state';
import {
    errorCode,
    isOwnedLauncher,
    isOwnedRuntime,
    removeOwnedUserData,
    runtimeStateSchema,
} from './runtime-state';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const RUNTIME_PATH = join(PROJECT_ROOT, '.records', 'acceptance', 'runtime.json');

export interface StopElectronDependencies {
    isOwnedLauncher: typeof isOwnedLauncher;
    isOwnedRuntime: typeof isOwnedRuntime;
    kill: (pid: number, signal: NodeJS.Signals) => void;
    log: (message: string) => void;
    now: () => number;
    readRuntime: () => Promise<string>;
    removeOwnedUserData: typeof removeOwnedUserData;
    runtimePath: string;
    sleep: (milliseconds: number) => Promise<void>;
    unlinkRuntime: () => Promise<void>;
}

const defaultDependencies: StopElectronDependencies = {
    isOwnedLauncher,
    isOwnedRuntime,
    kill: (pid, signal) => process.kill(pid, signal),
    log: (message) => console.log(message),
    now: Date.now,
    readRuntime: () => readFile(RUNTIME_PATH, 'utf8'),
    removeOwnedUserData,
    runtimePath: RUNTIME_PATH,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    unlinkRuntime: () => unlink(RUNTIME_PATH),
};

async function removeRuntimeFile(dependencies: StopElectronDependencies): Promise<void> {
    try {
        await dependencies.unlinkRuntime();
    } catch (error: unknown) {
        if (errorCode(error) !== 'ENOENT') throw error;
    }
}

/**
 * Stops only the process identity recorded by Acceptance and preserves state on timeout.
 */
export async function stopElectron(
    dependencies: StopElectronDependencies = defaultDependencies,
): Promise<void> {
    let runtime: RuntimeState;
    try {
        const raw: unknown = JSON.parse(await dependencies.readRuntime());
        runtime = runtimeStateSchema.parse(raw);
    } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT') {
            dependencies.log('No owned Caxri acceptance instance is running');
            return;
        }
        throw new Error(
            `Invalid ${dependencies.runtimePath}; inspect it before removing stale state`,
            { cause: error },
        );
    }

    if (!(await dependencies.isOwnedRuntime(runtime))) {
        await removeRuntimeFile(dependencies);
        await dependencies.removeOwnedUserData(runtime);
        dependencies.log('Removed stale Caxri acceptance runtime state');
        return;
    }

    const isLauncherAlive = await dependencies.isOwnedLauncher(runtime);
    const ownerPid = isLauncherAlive ? runtime.launcherPid : runtime.electronPid;
    if (!ownerPid) throw new Error('Owned Acceptance runtime has no live process PID');
    dependencies.kill(ownerPid, 'SIGTERM');

    const deadline = dependencies.now() + 10_000;
    // This is a poll loop: each iteration must await the previous liveness check and retry
    // delay before deciding whether to poll again, so the awaits below are intentionally
    // sequential.
    // eslint-disable-next-line no-await-in-loop
    while ((await dependencies.isOwnedRuntime(runtime)) && dependencies.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await dependencies.sleep(250);
    }
    if (await dependencies.isOwnedRuntime(runtime)) {
        throw new Error(
            `Acceptance owner PID ${ownerPid} did not stop; inspect it before taking further action`,
        );
    }

    await removeRuntimeFile(dependencies);
    await dependencies.removeOwnedUserData(runtime);
    dependencies.log('Stopped owned Caxri acceptance instance');
}

if (import.meta.main) {
    try {
        await stopElectron();
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
