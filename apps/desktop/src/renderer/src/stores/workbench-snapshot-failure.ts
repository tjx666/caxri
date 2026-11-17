import { isServerBusy } from '@caxri/protocol';

import { translate } from '../i18n';
import { describeFailure, isCancelledRequest, pushToast } from './toasts';

/**
 * Waits before each silent re-read of a snapshot the Server shed as busy; about 15 seconds in total, after which the
 * failure is reported like any other.
 */
export const SNAPSHOT_BUSY_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

export interface SnapshotFailureHandler {
    /**
     * Clears the busy retry budget once a snapshot read succeeds.
     */
    succeeded(): void;
    /**
     * Retries or reports one failed snapshot read.
     */
    failed(error: unknown, hasSnapshot: boolean): void;
}

/**
 * Handles failed full snapshot reads. Every read funnels through one path: the first one that fills an empty window and
 * every later refresh after a command or `state.changed`. Only the first leaves the window without Projects and
 * Sessions; a later failure keeps the last snapshot on screen, so its copy must not claim the window never loaded.
 *
 * A machine under heavy load can stall Server Core long enough that this Client's executing requests reach the Server's
 * per-peer limit, which then sheds new ones as `CAPACITY` with the busy marker. Nothing is wrong with the Projects or
 * Sessions, and the backlog drains on its own, so the read is retried with backoff instead of raising an error
 * notification; only a Server still busy after the whole budget is reported. Concurrent busy failures share one pending
 * retry.
 *
 * Quit refuses every queued Renderer request, so the last `state.changed` before the window closes lands here as a
 * cancellation. Reporting it would raise an error over an application that is already gone; `tryCommand` and
 * `shouldToastQueryError` apply the same rule to the other two failure funnels.
 */
export function createSnapshotFailureHandler(
    retry: () => void,
    schedule: (callback: () => void, delayMs: number) => unknown = setTimeout,
): SnapshotFailureHandler {
    let busyAttempts = 0;
    let isRetryPending = false;
    return {
        succeeded() {
            busyAttempts = 0;
        },
        failed(error, hasSnapshot) {
            if (isCancelledRequest(error)) return;
            const delayMs = isServerBusy(error)
                ? SNAPSHOT_BUSY_RETRY_DELAYS_MS[busyAttempts]
                : undefined;
            if (delayMs !== undefined) {
                busyAttempts += 1;
                if (isRetryPending) return;
                isRetryPending = true;
                schedule(() => {
                    isRetryPending = false;
                    retry();
                }, delayMs);
                return;
            }
            busyAttempts = 0;
            pushToast(
                'error',
                describeFailure(
                    error,
                    translate(
                        hasSnapshot
                            ? 'core.workbench.snapshotRefreshFailed'
                            : 'core.workbench.snapshotLoadFailed',
                    ),
                    translate,
                ),
            );
        },
    };
}
