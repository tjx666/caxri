import type { ChildProcess } from 'node:child_process';

interface CloseE2EAppOptions {
    applicationProcess: Pick<ChildProcess, 'exitCode' | 'signalCode'>;
    cleanup: () => Promise<void>;
    close: () => Promise<void>;
    handBackLease: () => Promise<void>;
    prepareBeforeClose?: () => Promise<void>;
    restoreBeforeClose?: () => Promise<void>;
}

/**
 * Hands the desktop lease back to the live test harness before Electron exits. Otherwise another worktree can reclaim
 * the now-stale Electron lease during Host cleanup, making the original run overlap its successor and fail teardown.
 */
export async function closeE2EApp({
    applicationProcess,
    cleanup,
    close,
    handBackLease,
    prepareBeforeClose,
    restoreBeforeClose,
}: CloseE2EAppOptions): Promise<void> {
    let failure: unknown;
    const isAppRunning =
        applicationProcess.exitCode === null && applicationProcess.signalCode === null;
    if (isAppRunning) {
        try {
            await handBackLease();
        } catch (error) {
            failure = error;
        }
        try {
            await restoreBeforeClose?.();
        } catch (error) {
            failure ??= error;
        }
        try {
            await prepareBeforeClose?.();
        } catch (error) {
            failure ??= error;
        }
        try {
            await close();
        } catch (error) {
            failure ??= error;
        }
    }
    try {
        await cleanup();
    } catch (error) {
        failure ??= error;
    }
    if (failure)
        throw failure instanceof Error
            ? failure
            : new Error('E2E application cleanup failed with a non-Error value');
}
