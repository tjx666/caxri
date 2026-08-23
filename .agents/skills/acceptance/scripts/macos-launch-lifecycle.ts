import process from 'node:process';

import { stopMacosAcceptanceProcesses } from './macos-app-identity';
import { errorCode, isAlive } from './runtime-state';

interface StoppableProcess {
    kill(signal?: NodeJS.Signals | number): boolean;
    pid?: number;
}

interface StopControllerDependencies {
    isAlive: typeof isAlive;
    scheduleForceStop: (callback: () => void, milliseconds: number) => { unref: () => void };
}

interface MacosAcceptanceLaunchControllerDependencies {
    createElectronController: (pid: number) => { readonly isStopping: boolean; stop: () => void };
    stopUndiscoveredProcesses: (executablePath: string) => Promise<unknown>;
}

const defaultStopControllerDependencies: StopControllerDependencies = {
    isAlive,
    scheduleForceStop: (callback, milliseconds) => setTimeout(callback, milliseconds),
};

/**
 * Makes shutdown idempotent and escalates only when the exact spawned process is still alive.
 */
export function createElectronStopController(
    child: StoppableProcess,
    dependencies: StopControllerDependencies = defaultStopControllerDependencies,
): { readonly isStopping: boolean; stop: () => void } {
    let isStopping = false;
    return {
        get isStopping() {
            return isStopping;
        },
        stop() {
            if (isStopping) return;
            isStopping = true;
            if (dependencies.isAlive(child.pid)) child.kill('SIGTERM');
            const forceTimer = dependencies.scheduleForceStop(() => {
                if (dependencies.isAlive(child.pid)) child.kill('SIGKILL');
            }, 5_000);
            forceTimer.unref();
        },
    };
}

function stoppableProcess(pid: number): StoppableProcess {
    return {
        kill(signal) {
            try {
                process.kill(pid, signal);
                return true;
            } catch (error: unknown) {
                if (errorCode(error) === 'ESRCH') return false;
                throw error;
            }
        },
        pid,
    };
}

const defaultMacosLaunchControllerDependencies: MacosAcceptanceLaunchControllerDependencies = {
    createElectronController: (pid) => createElectronStopController(stoppableProcess(pid)),
    stopUndiscoveredProcesses: stopMacosAcceptanceProcesses,
};

/**
 * Owns shutdown from `open -W` start through exact Main PID discovery. Before PID binding, shutdown sweeps only the
 * unique cloned executable path; after binding, ordinary PID-owned TERM/KILL escalation is authoritative.
 */
export function createMacosAcceptanceLaunchController(
    launchProcess: StoppableProcess,
    executablePath: string,
    dependencies: MacosAcceptanceLaunchControllerDependencies = defaultMacosLaunchControllerDependencies,
) {
    let electronController: { readonly isStopping: boolean; stop: () => void } | undefined;
    let isStopping = false;
    let cleanupPromise: Promise<void> | undefined;
    const stop = (): void => {
        if (isStopping) return;
        isStopping = true;
        if (electronController) electronController.stop();
        else launchProcess.kill('SIGTERM');
    };
    return {
        bindElectronPid(pid: number): void {
            if (electronController) throw new Error('Acceptance Electron PID is already bound');
            electronController = dependencies.createElectronController(pid);
            if (isStopping) electronController.stop();
        },
        cleanup(): Promise<void> {
            cleanupPromise ??= (async () => {
                stop();
                if (!electronController) {
                    await dependencies.stopUndiscoveredProcesses(executablePath);
                }
            })();
            return cleanupPromise;
        },
        get isStopping(): boolean {
            return isStopping || electronController?.isStopping === true;
        },
        stop,
    };
}

interface MacosAcceptanceLaunchCleanupController {
    cleanup: () => Promise<void>;
}

type MacosAcceptanceLaunchCleanupResult =
    | { cleanupError?: undefined; isSafeToRemoveProfile: true }
    | { cleanupError: unknown; isSafeToRemoveProfile: false };

/**
 * Settles the `open -W` supervisor and always detaches process signal listeners. A failed unique-path sweep means
 * process absence was not proven, so the caller must retain the per-launch profile and cloned app for recovery.
 */
export async function settleMacosAcceptanceLaunch(
    launchController: MacosAcceptanceLaunchCleanupController,
    childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
    removeSignalListeners: () => void,
): Promise<MacosAcceptanceLaunchCleanupResult> {
    let cleanupResult: MacosAcceptanceLaunchCleanupResult = {
        isSafeToRemoveProfile: true,
    };
    try {
        await launchController.cleanup();
    } catch (error: unknown) {
        cleanupResult = { cleanupError: error, isSafeToRemoveProfile: false };
    }
    try {
        await childExit;
    } catch {
        // Ignored during cleanup; the process is already being torn down.
    } finally {
        removeSignalListeners();
    }
    return cleanupResult;
}
