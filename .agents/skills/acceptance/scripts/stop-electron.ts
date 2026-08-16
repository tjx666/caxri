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

async function main(): Promise<void> {
    let runtime: RuntimeState;
    try {
        const raw: unknown = JSON.parse(await readFile(RUNTIME_PATH, 'utf8'));
        runtime = runtimeStateSchema.parse(raw);
    } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT') {
            console.log('No owned Caxri acceptance instance is running');
            return;
        }
        throw new Error(`Invalid ${RUNTIME_PATH}; inspect it before removing stale state`, {
            cause: error,
        });
    }

    if (!(await isOwnedRuntime(runtime))) {
        try {
            await unlink(RUNTIME_PATH);
        } catch (error: unknown) {
            if (errorCode(error) !== 'ENOENT') throw error;
        }
        await removeOwnedUserData(runtime);
        console.log('Removed stale Caxri acceptance runtime state');
        return;
    }

    const isLauncherAlive = await isOwnedLauncher(runtime);
    const ownerPid = isLauncherAlive ? runtime.launcherPid : runtime.electronPid;
    if (!ownerPid) throw new Error('Owned Acceptance runtime has no live process PID');
    process.kill(ownerPid, 'SIGTERM');

    const deadline = Date.now() + 10_000;
    // This is a poll loop: each iteration must await the previous liveness check and retry
    // delay before deciding whether to poll again, so the awaits below are intentionally
    // sequential.
    // eslint-disable-next-line no-await-in-loop
    while ((await isOwnedRuntime(runtime)) && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    if (await isOwnedRuntime(runtime)) {
        throw new Error(
            `Acceptance owner PID ${ownerPid} did not stop; inspect it before taking further action`,
        );
    }

    try {
        await unlink(RUNTIME_PATH);
    } catch (error: unknown) {
        if (errorCode(error) !== 'ENOENT') throw error;
    }
    await removeOwnedUserData(runtime);
    console.log('Stopped owned Caxri acceptance instance');
}

try {
    await main();
} catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
