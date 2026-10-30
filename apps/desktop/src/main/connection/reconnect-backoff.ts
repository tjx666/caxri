/**
 * How long an outage may be treated as the reconnect window; see `DesktopServerConnection.isRecovering`. The case this
 * classification exists for is a sleep/wake reattach, which settles in seconds, but the bound is sized against the
 * loop's worst case instead: a single attempt may burn the supervisor's 15s readiness deadline before failing, and the
 * backoff between attempts grows to a 10s cap, so a reattach that only succeeds on its sixth attempt still completes
 * inside two minutes. A tighter bound would report a slow but healthy recovery as a fault, which is the noise this
 * classification was added to remove. The bound exists only so an outage that never resolves stops being downgraded
 * forever.
 */
export const RECOVERY_WINDOW_MS = 120_000;

/**
 * The reconnect loop's interruptible backoff wait. The wake handle exists only while a sleep is pending, so
 * {@link ReconnectBackoff.wake} cannot skip an attempt that is already running.
 */
export class ReconnectBackoff {
    private wakeCurrent?: () => void;

    /**
     * Sleeps one backoff interval, ending early when {@link wake} is called.
     */
    async wait(backoffMs: number): Promise<void> {
        const sleep = Promise.withResolvers<void>();
        const timer = setTimeout(sleep.resolve, backoffMs);
        const wake = (): void => {
            clearTimeout(timer);
            sleep.resolve();
        };
        this.wakeCurrent = wake;
        await sleep.promise;
        if (this.wakeCurrent === wake) this.wakeCurrent = undefined;
    }

    /**
     * Ends the pending wait so the next attempt starts now. Returns whether a wait was pending.
     */
    wake(): boolean {
        const wake = this.wakeCurrent;
        if (!wake) return false;
        wake();
        return true;
    }
}
