/**
 * A bare SIGTERM/SIGINT must not race Server Core's own `host.shutdown` request, which is the only path that persists
 * captured snapshots (Terminal Host owns no filesystem or database access of its own). If the parent IPC channel is
 * still connected when the signal arrives, Server Core is likely mid-`stop()` and about to send that request; give it a
 * bounded window to arrive before falling back to this process's own unmanaged shutdown.
 */
const TERMINATION_SIGNAL_GRACE_MS = 3_000;

/**
 * Minimal signal-source contract so the wiring can be exercised without wrapping `process` itself in a test.
 */
interface TerminationSignalTarget {
    once(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

export interface InstallTerminationSignalHandlersOptions {
    target: TerminationSignalTarget;
    isConnected: () => boolean;
    waitForShutdownRequest: (timeoutMs: number) => Promise<boolean>;
    stop: (exitCode: number) => Promise<void>;
    graceMs?: number;
}

/**
 * Registers a SIGTERM/SIGINT handler that yields the grace window to Server Core's `host.shutdown` before falling back
 * to the local unmanaged shutdown. Skipping the wait when the IPC channel is already gone keeps a signal delivered
 * after parent-disconnect from stalling exit for no reason.
 */
export function installTerminationSignalHandlers(
    options: InstallTerminationSignalHandlersOptions,
): void {
    const graceMs = options.graceMs ?? TERMINATION_SIGNAL_GRACE_MS;
    const onSignal = (): void => {
        void (async () => {
            if (options.isConnected()) await options.waitForShutdownRequest(graceMs);
            await options.stop(0);
        })();
    };
    options.target.once('SIGTERM', onSignal);
    options.target.once('SIGINT', onSignal);
}
