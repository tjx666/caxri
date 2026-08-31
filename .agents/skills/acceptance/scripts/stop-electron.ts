import { readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { OwnedProcess, RuntimeState } from './runtime-state';
import {
    discoverOwnedProcesses,
    errorCode,
    isOwnedLauncher,
    isOwnedProcess,
    isOwnedRuntime,
    removeOwnedUserData,
    runtimeStateSchema,
    writeRuntimeState,
} from './runtime-state';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const RUNTIME_PATH = join(PROJECT_ROOT, '.records', 'acceptance', 'runtime.json');

export interface StopElectronDependencies {
    discoverOwnedProcesses: typeof discoverOwnedProcesses;
    isCdpReachable: (cdpUrl: string) => Promise<boolean>;
    isOwnedLauncher: typeof isOwnedLauncher;
    isOwnedProcess: typeof isOwnedProcess;
    isOwnedRuntime: typeof isOwnedRuntime;
    kill: (pid: number, signal: NodeJS.Signals) => void;
    log: (message: string) => void;
    now: () => number;
    projectRoot: string;
    readRuntime: () => Promise<string>;
    removeOwnedUserData: typeof removeOwnedUserData;
    runtimePath: string;
    sleep: (milliseconds: number) => Promise<void>;
    unlinkRuntime: () => Promise<void>;
    writeRuntime: (runtime: RuntimeState) => Promise<void>;
}

const defaultDependencies: StopElectronDependencies = {
    discoverOwnedProcesses,
    isCdpReachable: async (cdpUrl) => {
        try {
            const response = await fetch(`${cdpUrl}/json/version`, {
                signal: AbortSignal.timeout(500),
            });
            return response.ok;
        } catch {
            return false;
        }
    },
    isOwnedLauncher,
    isOwnedProcess,
    isOwnedRuntime,
    kill: (pid, signal) => process.kill(pid, signal),
    log: (message) => console.log(message),
    now: Date.now,
    projectRoot: PROJECT_ROOT,
    readRuntime: () => readFile(RUNTIME_PATH, 'utf8'),
    removeOwnedUserData,
    runtimePath: RUNTIME_PATH,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    unlinkRuntime: () => unlink(RUNTIME_PATH),
    writeRuntime: (runtime) => writeRuntimeState(RUNTIME_PATH, runtime),
};

async function removeRuntimeFile(dependencies: StopElectronDependencies): Promise<void> {
    try {
        await dependencies.unlinkRuntime();
    } catch (error: unknown) {
        if (errorCode(error) !== 'ENOENT') throw error;
    }
}

function processKey(processIdentity: { identity: string; pid: number }): string {
    return `${processIdentity.pid}:${processIdentity.identity}`;
}

async function didSignalExactProcess(
    processIdentity: { identity: string; pid: number },
    signal: NodeJS.Signals,
    dependencies: StopElectronDependencies,
): Promise<boolean> {
    if (!(await dependencies.isOwnedProcess(processIdentity))) return false;
    try {
        dependencies.kill(processIdentity.pid, signal);
        return true;
    } catch (error: unknown) {
        if (errorCode(error) === 'ESRCH') return false;
        throw error;
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

    const hasPersistedProcessOwnership = runtime.ownedProcesses.length > 0;
    const capturedProcesses = new Map<
        string,
        Awaited<ReturnType<typeof dependencies.discoverOwnedProcesses>>[number]
    >();
    for (const ownedProcess of runtime.ownedProcesses) {
        capturedProcesses.set(processKey(ownedProcess), ownedProcess);
    }
    const acceptedServerCoreKeys = new Set(
        runtime.ownedProcesses
            .filter(({ role }) => role === 'server-core')
            .map((ownedProcess) => processKey(ownedProcess)),
    );
    let isShutdownStarted = false;
    const captureCurrentProcesses = async (): Promise<void> => {
        const discoveredProcesses = await dependencies.discoverOwnedProcesses(
            runtime,
            dependencies.projectRoot,
        );
        const discoveredServerCore = discoveredProcesses.find(({ role }) => role === 'server-core');
        if (discoveredServerCore) {
            const discoveredServerCoreKey = processKey(discoveredServerCore);
            if (
                !isShutdownStarted &&
                acceptedServerCoreKeys.size > 0 &&
                !acceptedServerCoreKeys.has(discoveredServerCoreKey)
            ) {
                throw new Error('Acceptance profile owner changed process identity');
            }
            acceptedServerCoreKeys.add(discoveredServerCoreKey);
        }
        let isOwnershipChanged = false;
        for (const ownedProcess of discoveredProcesses) {
            const key = processKey(ownedProcess);
            if (!capturedProcesses.has(key)) {
                capturedProcesses.set(key, ownedProcess);
                runtime.ownedProcesses.push(ownedProcess);
                isOwnershipChanged = true;
            }
        }
        /**
         * Persist every exact Server generation before signaling so a later orphan remains recoverable.
         */
        if (isOwnershipChanged) await dependencies.writeRuntime(runtime);
    };
    await captureCurrentProcesses();

    if (!hasPersistedProcessOwnership && capturedProcesses.size === 0) {
        throw new Error(
            'Acceptance process ownership was never verified; runtime state and profile were preserved',
        );
    }
    /**
     * A verified Desktop can restart its detached Server while shutdown is in flight. Discovery still binds the new
     * generation to this exact profile, so persist and stop it instead of stranding the profile after Electron exits.
     */
    isShutdownStarted = true;

    const signaledProcesses = new Set<string>();
    const signalOnce = async (
        processIdentity: { identity: string; pid: number },
        signal: NodeJS.Signals,
    ): Promise<void> => {
        const key = `${signal}:${processKey(processIdentity)}`;
        if (signaledProcesses.has(key)) return;
        if (await didSignalExactProcess(processIdentity, signal, dependencies)) {
            signaledProcesses.add(key);
        }
    };

    const isLauncherAlive = await dependencies.isOwnedLauncher(runtime);
    const desktopOwner = isLauncherAlive
        ? { identity: runtime.launcherIdentity, pid: runtime.launcherPid }
        : runtime.electronPid && runtime.electronIdentity
          ? { identity: runtime.electronIdentity, pid: runtime.electronPid }
          : undefined;
    if (desktopOwner) await signalOnce(desktopOwner, 'SIGTERM');
    for (const ownedProcess of capturedProcesses.values()) {
        if (ownedProcess.role === 'server-core') {
            // eslint-disable-next-line no-await-in-loop -- exact identities must be rechecked immediately before signal
            await signalOnce(ownedProcess, 'SIGTERM');
        }
    }

    const deadline = dependencies.now() + 10_000;
    const forceDeadline = dependencies.now() + 5_000;
    // This is a poll loop: each iteration must await the previous liveness check and retry
    // delay before deciding whether to poll again, so the awaits below are intentionally
    // sequential.

    while (dependencies.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- discovery and identity checks are one ordered ownership snapshot
        await captureCurrentProcesses();
        const liveProcesses: OwnedProcess[] = [];
        for (const ownedProcess of capturedProcesses.values()) {
            // eslint-disable-next-line no-await-in-loop -- every signal decision rechecks the exact captured identity
            if (await dependencies.isOwnedProcess(ownedProcess)) liveProcesses.push(ownedProcess);
        }
        const liveServerCores = liveProcesses.filter(({ role }) => role === 'server-core');
        for (const serverCore of liveServerCores) {
            // eslint-disable-next-line no-await-in-loop -- newly discovered generations are signaled exactly once
            await signalOnce(serverCore, 'SIGTERM');
        }
        if (liveServerCores.length === 0) {
            for (const ownedProcess of liveProcesses) {
                if (ownedProcess.role === 'extension-host') {
                    // eslint-disable-next-line no-await-in-loop -- orphan process cleanup follows verified Server exit
                    await signalOnce(ownedProcess, 'SIGTERM');
                }
            }
        }
        if (dependencies.now() >= forceDeadline) {
            for (const ownedProcess of liveProcesses) {
                // eslint-disable-next-line no-await-in-loop -- escalation retains the same exact immutable identity
                await signalOnce(ownedProcess, 'SIGKILL');
            }
            // eslint-disable-next-line no-await-in-loop -- escalation retains the exact Desktop owner identity
            if (desktopOwner) await signalOnce(desktopOwner, 'SIGKILL');
        }

        // eslint-disable-next-line no-await-in-loop -- final state follows the ordered ownership snapshot above
        const [isDesktopStillOwned, isCdpStillReachable] = await Promise.all([
            dependencies.isOwnedRuntime(runtime),
            dependencies.isCdpReachable(runtime.cdpUrl),
        ]);
        if (!isDesktopStillOwned && !isCdpStillReachable && liveProcesses.length === 0) break;
        // eslint-disable-next-line no-await-in-loop
        await dependencies.sleep(250);
    }
    const remainingProcesses: OwnedProcess[] = [];
    for (const ownedProcess of capturedProcesses.values()) {
        // eslint-disable-next-line no-await-in-loop -- final receipt requires every captured identity to be gone
        if (await dependencies.isOwnedProcess(ownedProcess)) remainingProcesses.push(ownedProcess);
    }
    const [isDesktopStillOwned, isCdpStillReachable] = await Promise.all([
        dependencies.isOwnedRuntime(runtime),
        dependencies.isCdpReachable(runtime.cdpUrl),
    ]);
    if (isDesktopStillOwned || isCdpStillReachable || remainingProcesses.length > 0) {
        throw new Error(
            'Owned Acceptance processes or CDP did not stop; runtime state was preserved',
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
