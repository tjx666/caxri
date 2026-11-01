const DEFAULT_SERIAL_LOCK_WAIT_MS = 10_000;
const MAX_SERIAL_LOCK_WAIT_SECONDS = 1800;
const SERIAL_LOCK_WAIT_VARIABLE = 'CAXRI_MOBILE_ACCEPTANCE_SERIAL_LOCK_WAIT';

/**
 * Reads `CAXRI_MOBILE_ACCEPTANCE_SERIAL_LOCK_WAIT`: whole seconds from 1 to 1800, mirroring `start-electron.ts
 * --lease-wait`. Unset keeps the repository lock's 10-second default, so a sibling worktree's round on the same
 * emulator fails fast unless the caller chose to wait for it.
 */
export function androidSerialLockWaitMs(raw: string | undefined): number {
    if (raw === undefined) return DEFAULT_SERIAL_LOCK_WAIT_MS;
    const seconds = /^\d+$/u.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_SERIAL_LOCK_WAIT_SECONDS) {
        throw new Error(
            `${SERIAL_LOCK_WAIT_VARIABLE} requires an integer from 1 to ${MAX_SERIAL_LOCK_WAIT_SECONDS} seconds`,
        );
    }
    return seconds * 1000;
}

/**
 * A busy serial without an explicit wait names the variable: the error is all an Agent reads at that moment, and
 * without it the Agent polls the sibling's PID by hand and reruns.
 */
export function withAndroidSerialLockWaitHint(error: unknown, raw: string | undefined): unknown {
    if (
        raw !== undefined ||
        !(error instanceof Error) ||
        !error.message.startsWith('Timed out waiting for switch-worktree operation PID')
    )
        return error;
    return new Error(
        `${error.message}\nAnother worktree's Android Acceptance round holds this emulator. To wait for it, rerun with ` +
            `${SERIAL_LOCK_WAIT_VARIABLE}=<seconds> (1-${MAX_SERIAL_LOCK_WAIT_SECONDS}).`,
        { cause: error },
    );
}
