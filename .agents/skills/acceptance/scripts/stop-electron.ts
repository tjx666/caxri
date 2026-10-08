import { readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { recordDeferredAgentFixtureCleanup } from './agent-fixture-lifecycle';
import { forceCompleteCaseLifecycle } from './case-lifecycle';
import type { OwnedProcess, RuntimeState } from './runtime-state';
import {
    discoverOwnedProcesses,
    errorCode,
    isOwnedLauncher,
    isOwnedProcess,
    isOwnedRuntime,
    isOwnedUserDataRemoved,
    removeOwnedUserData,
    runtimeStateSchema,
    writeRuntimeState,
} from './runtime-state';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const RUNTIME_PATH = join(PROJECT_ROOT, '.records', 'acceptance', 'runtime.json');
/**
 * The launcher tears down Electron, discovers detached Server generations, removes the profile, and writes the case
 * lifecycle receipt in its own `finally`. A profile with heavy watcher state takes well over the old five-second
 * window, so the launcher is only escalated after this long without any observable teardown progress.
 */
const DEFAULT_LAUNCHER_GRACE_MS = 30_000;
/**
 * Progress can keep renewing the grace: a stalled main thread makes the CDP probe flap and a restarted Server
 * generation moves the live count. This multiple of the grace is the absolute ceiling of the launcher tier, so a
 * teardown that never converges is still escalated. With the default grace the launcher tier ends within 90s and the
 * owned-process tier within a further 10s, inside the 120s budget an agent shell gives the documented stop command.
 */
const LAUNCHER_DEADLINE_MULTIPLIER = 3;
const OWNED_PROCESS_FORCE_DELAY_MS = 5_000;
const OWNED_PROCESS_DEADLINE_MS = 10_000;
const POLL_INTERVAL_MS = 250;

export interface StopElectronDependencies {
    discoverOwnedProcesses: typeof discoverOwnedProcesses;
    forceCompleteCaseLifecycle: typeof forceCompleteCaseLifecycle;
    isCdpReachable: (cdpUrl: string) => Promise<boolean>;
    isOwnedLauncher: typeof isOwnedLauncher;
    isOwnedProcess: typeof isOwnedProcess;
    isOwnedRuntime: typeof isOwnedRuntime;
    isOwnedUserDataRemoved: typeof isOwnedUserDataRemoved;
    kill: (pid: number, signal: NodeJS.Signals) => void;
    log: (message: string) => void;
    now: () => number;
    projectRoot: string;
    readRuntime: () => Promise<string>;
    recordDeferredAgentFixtureCleanup: typeof recordDeferredAgentFixtureCleanup;
    removeOwnedUserData: typeof removeOwnedUserData;
    runtimePath: string;
    sleep: (milliseconds: number) => Promise<void>;
    unlinkRuntime: () => Promise<void>;
    writeRuntime: (runtime: RuntimeState) => Promise<void>;
}

export interface StopElectronOptions {
    /**
     * Milliseconds the launcher may go without teardown progress before it is force-killed.
     */
    launcherGraceMs?: number;
}

const defaultDependencies: StopElectronDependencies = {
    discoverOwnedProcesses,
    forceCompleteCaseLifecycle,
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
    isOwnedUserDataRemoved,
    kill: (pid, signal) => process.kill(pid, signal),
    log: (message) => console.log(message),
    now: Date.now,
    projectRoot: PROJECT_ROOT,
    readRuntime: () => readFile(RUNTIME_PATH, 'utf8'),
    recordDeferredAgentFixtureCleanup,
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

function parseLauncherGrace(argv: string[]): StopElectronOptions {
    const options: StopElectronOptions = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--launcher-grace-ms') {
            const value = Number(argv[++index]);
            if (!Number.isSafeInteger(value) || value < 0) {
                throw new Error('--launcher-grace-ms must be a non-negative integer');
            }
            options.launcherGraceMs = value;
        } else {
            throw new Error(`Unknown option: ${token}`);
        }
    }
    return options;
}

/**
 * Completes the launcher's lifecycle receipt when the launcher could not. The launcher normally writes it in its own
 * `finally`; `already_completed` means it did, and nothing is overwritten.
 */
type LauncherOutcome = 'absent' | 'exited' | 'force_killed' | 'deadline_killed';

const RECEIPT_COMPLETION_REASON: Record<LauncherOutcome, string> = {
    absent: 'the launcher was already gone when stop-electron ran',
    deadline_killed:
        'stop-electron force-killed the launcher because its teardown exceeded the absolute deadline',
    exited: 'the launcher exited without completing its lifecycle receipt',
    force_killed:
        'stop-electron force-killed the launcher after it stopped making teardown progress',
};

const LAUNCHER_OUTCOME_LABEL: Record<LauncherOutcome, string> = {
    absent: 'already-gone',
    deadline_killed: 'deadline-killed',
    exited: 'exited',
    force_killed: 'force-killed',
};

async function completeLifecycleReceiptIfPending(
    runtime: RuntimeState,
    launcherOutcome: LauncherOutcome,
    dependencies: StopElectronDependencies,
): Promise<void> {
    const acceptanceCase = runtime.acceptanceCase;
    if (!acceptanceCase) return;
    if (!acceptanceCase.reportDirectory || !acceptanceCase.lifecycleLaunchId) {
        // Recorded with its cause so a pending receipt is not first discovered at `report.ts finalize`.
        dependencies.log(
            `Runtime state for Acceptance case ${acceptanceCase.id} records no lifecycle receipt ownership; ` +
                'if its launch is still pending, close it with ' +
                `\`report.ts repair-lifecycle --dir <round> --case-id ${acceptanceCase.id} --reason "<why>"\``,
        );
        return;
    }
    const cleanupCompleted =
        runtime.ownedUserData && (await dependencies.isOwnedUserDataRemoved(runtime));
    const result = await dependencies.forceCompleteCaseLifecycle(acceptanceCase.reportDirectory, {
        caseId: acceptanceCase.id,
        cleanupCompleted,
        cleanupRequested: runtime.ownedUserData,
        launchId: acceptanceCase.lifecycleLaunchId,
        reason: RECEIPT_COMPLETION_REASON[launcherOutcome],
        source: 'stop-electron',
    });
    if (result === 'completed') {
        dependencies.log(
            `Completed lifecycle receipt for Acceptance case ${acceptanceCase.id} on behalf of the ${
                LAUNCHER_OUTCOME_LABEL[launcherOutcome]
            } launcher`,
        );
    } else if (result === 'cleanup_recorded') {
        dependencies.log(
            `Recorded deferred profile cleanup for Acceptance case ${acceptanceCase.id}: the launcher completed its ` +
                'receipt while a detached Server generation still held the profile',
        );
    }
    // The fake Agent fixture root lives inside the same profile, so its receipt is amended under the same verification.
    if (cleanupCompleted && acceptanceCase.agentFixtureLaunchId) {
        const fixtureResult = await dependencies.recordDeferredAgentFixtureCleanup(
            acceptanceCase.reportDirectory,
            {
                caseId: acceptanceCase.id,
                launchId: acceptanceCase.agentFixtureLaunchId,
                sharedProfile: acceptanceCase.mode === 'restart',
                source: 'stop-electron',
            },
        );
        if (fixtureResult === 'cleanup_recorded') {
            dependencies.log(
                `Recorded deferred Agent fixture cleanup for Acceptance case ${acceptanceCase.id}`,
            );
        } else if (fixtureResult === 'pending') {
            // Only the launcher closes a pending fixture launch; say so here rather than at `report.ts finalize`.
            dependencies.log(
                `Agent fixture receipt for Acceptance case ${acceptanceCase.id} is still pending; the launcher never ` +
                    'completed it, so the case cannot finalize until it is relaunched on a fresh profile',
            );
        }
    }
}

/**
 * Stops only the process identity recorded by Acceptance and preserves state on timeout.
 *
 * Stopping is two-tier. While the launcher is alive it owns the teardown: it receives SIGTERM alone, its children are
 * left to it, and it is escalated only after `launcherGraceMs` without observable progress. Only once the launcher is
 * gone does the adapter signal the window and Server generations directly with the short force escalation, so the
 * launcher's receipt writer is never killed from under it. Tracked in #611.
 */
export async function stopElectron(
    dependencies: StopElectronDependencies = defaultDependencies,
    options: StopElectronOptions = {},
): Promise<void> {
    const launcherGraceMs = options.launcherGraceMs ?? DEFAULT_LAUNCHER_GRACE_MS;
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

    const countLiveProcesses = async (): Promise<OwnedProcess[]> => {
        const liveProcesses: OwnedProcess[] = [];
        for (const ownedProcess of capturedProcesses.values()) {
            // eslint-disable-next-line no-await-in-loop -- every signal decision rechecks the exact captured identity
            if (await dependencies.isOwnedProcess(ownedProcess)) liveProcesses.push(ownedProcess);
        }
        return liveProcesses;
    };

    const desktopOwner =
        runtime.electronPid && runtime.electronIdentity
            ? { identity: runtime.electronIdentity, pid: runtime.electronPid }
            : undefined;
    let launcherOutcome: LauncherOutcome = 'absent';
    if (await dependencies.isOwnedLauncher(runtime)) {
        const launcher = { identity: runtime.launcherIdentity, pid: runtime.launcherPid };
        await signalOnce(launcher, 'SIGTERM');
        launcherOutcome = 'exited';
        /**
         * Progress means the launcher's teardown is visibly advancing: the window process exited, the CDP endpoint went
         * away, or an owned process exited. The window is probed by its own identity rather than through
         * `isOwnedRuntime`, which reports the runtime as owned for as long as the launcher itself is alive and so could
         * never register the window's exit here. A launcher that keeps progressing is left alone until the absolute
         * deadline; a quiet one is escalated after one grace period.
         */
        const startedAt = dependencies.now();
        const deadline = startedAt + launcherGraceMs * LAUNCHER_DEADLINE_MULTIPLIER;
        let lastProgressAt = startedAt;
        let previousSnapshot: string | undefined;
        let pollCount = 0;
        // This is a poll loop: each iteration must await the previous liveness check and retry
        // delay before deciding whether to poll again, so the awaits below are intentionally
        // sequential.
        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- the launcher's exact identity gates every poll
            if (!(await dependencies.isOwnedLauncher(runtime))) break;
            pollCount += 1;
            // eslint-disable-next-line no-await-in-loop -- discovery persists new Server generations before signaling
            await captureCurrentProcesses();
            // eslint-disable-next-line no-await-in-loop -- one ordered ownership snapshot per poll
            const [isWindowAlive, isCdpReachable, liveProcesses] = await Promise.all([
                desktopOwner ? dependencies.isOwnedProcess(desktopOwner) : false,
                dependencies.isCdpReachable(runtime.cdpUrl),
                countLiveProcesses(),
            ]);
            const snapshot = `${isWindowAlive}:${isCdpReachable}:${liveProcesses.length}`;
            const now = dependencies.now();
            if (previousSnapshot !== undefined && snapshot !== previousSnapshot) {
                lastProgressAt = now;
            }
            previousSnapshot = snapshot;
            const isQuiet = now - lastProgressAt >= launcherGraceMs;
            if (isQuiet || now >= deadline) {
                dependencies.log(
                    isQuiet
                        ? `Acceptance launcher made no teardown progress for ${launcherGraceMs}ms; force-killing it`
                        : `Acceptance launcher teardown exceeded the ${deadline - startedAt}ms deadline; force-killing it`,
                );
                // eslint-disable-next-line no-await-in-loop -- escalation retains the exact launcher identity
                await signalOnce(launcher, 'SIGKILL');
                launcherOutcome = isQuiet ? 'force_killed' : 'deadline_killed';
                break;
            }
            // eslint-disable-next-line no-await-in-loop
            await dependencies.sleep(POLL_INTERVAL_MS);
        }
        // Measured so teardown creeping toward the grace is visible before force-kills return (#611).
        dependencies.log(
            `Acceptance launcher ${LAUNCHER_OUTCOME_LABEL[launcherOutcome]} after ${
                dependencies.now() - startedAt
            }ms (${pollCount} polls, grace ${launcherGraceMs}ms)`,
        );
    }

    /**
     * The launcher is gone. Whatever it left behind (a window whose ownership it never released, a detached Server
     * generation, an Extension Host orphan) is now signaled directly with the short force escalation.
     */
    await captureCurrentProcesses();
    if (desktopOwner) await signalOnce(desktopOwner, 'SIGTERM');
    for (const ownedProcess of capturedProcesses.values()) {
        if (ownedProcess.role === 'server-core') {
            // eslint-disable-next-line no-await-in-loop -- exact identities must be rechecked immediately before signal
            await signalOnce(ownedProcess, 'SIGTERM');
        }
    }

    const deadline = dependencies.now() + OWNED_PROCESS_DEADLINE_MS;
    const forceDeadline = dependencies.now() + OWNED_PROCESS_FORCE_DELAY_MS;
    // This is a poll loop: each iteration must await the previous liveness check and retry
    // delay before deciding whether to poll again, so the awaits below are intentionally
    // sequential.

    while (dependencies.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- discovery and identity checks are one ordered ownership snapshot
        await captureCurrentProcesses();
        // eslint-disable-next-line no-await-in-loop -- every signal decision rechecks the exact captured identity
        const liveProcesses = await countLiveProcesses();
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
        await dependencies.sleep(POLL_INTERVAL_MS);
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
    // A launcher that crashed or was killed externally before this stop never wrote its receipt either.
    await completeLifecycleReceiptIfPending(runtime, launcherOutcome, dependencies);
    dependencies.log('Stopped owned Caxri acceptance instance');
}

if (import.meta.main) {
    try {
        await stopElectron(defaultDependencies, parseLauncherGrace(process.argv.slice(2)));
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
