import type { ServerIdleExitDeferralReason } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

/**
 * Default idle-exit threshold: how long Server Core waits, with zero authenticated connections of any kind (Desktop,
 * Mobile, Agent, or CLI) and no live PTY, before it exits through its normal shutdown path. See
 * `docs/adr/0010-server-core-idle-exit.md` for the decision this implements.
 *
 * 30 minutes comfortably outlives every ordinary Desktop restart or update-adoption gap (quit, install, relaunch is a
 * matter of seconds; a user who postpones the relaunch prompt still has a wide window) while still reclaiming a Server
 * left behind by a crashed or force-killed Desktop in well under the 41-hour orphan this feature exists to fix (issue
 * #1234). It is not a user-facing setting — see `idleExitThresholdMs` on `ServerCoreOptions` and the
 * `CAXRI_SERVER_IDLE_EXIT_MS` internal override read in `apps/server/src/core/process.ts`.
 */
export const DEFAULT_IDLE_EXIT_MS = 30 * 60_000;

export interface IdleExitMonitorOptions {
    /**
     * Resolves `true` while shutdown must be postponed (currently: at least one live PTY — see
     * `ServerIdleExitDeferralReason`). A rejection is treated as busy: an idle-exit sweep has nobody to ask for
     * confirmation, so an unexpected health-check failure must defer rather than risk destroying live work.
     */
    isBusy(): Promise<boolean> | boolean;
    logger?: Pick<StructuredLogger, 'write'>;
    /**
     * Test seam; production uses `Date.now`.
     */
    now?(): number;
    onIdleExit(info: { deferralCount: number; idleDurationMs: number }): void;
    /**
     * Test seam; production uses `DEFAULT_IDLE_EXIT_MS`.
     */
    thresholdMs?: number;
}

export interface IdleExitMonitor {
    /**
     * Reports the current aggregate authenticated connection count across every transport.
     */
    updateConnectionCount(count: number): void;
    /**
     * Disarms any pending check; safe to call more than once. Called once Core itself starts stopping.
     */
    stop(): void;
}

/**
 * Watches the aggregate authenticated connection count (Desktop, Mobile, Agent, and CLI clients combined — see
 * `server-core.ts`'s wiring) and, once it has stayed at zero for `thresholdMs`, triggers `onIdleExit` unless `isBusy()`
 * says live work is in flight, in which case it logs a deferral and rechecks after another full `thresholdMs` window.
 *
 * A connection count above zero cancels the pending check outright and resets the idle clock and deferral count, so a
 * reconnect within the threshold (e.g. a restarted Desktop re-attaching) leaves no residual state. Only the
 * nonzero->zero transition starts the idle clock; a repeated zero report does not push the check back out, so a
 * transport that re-announces an unchanged zero count cannot postpone exit past the original threshold.
 */
export function createIdleExitMonitor(options: IdleExitMonitorOptions): IdleExitMonitor {
    let connectionCount = 0;
    let deferralCount = 0;
    let idleSinceMs: number | undefined;
    let isStopped = false;
    let timer: NodeJS.Timeout | undefined;

    const now = (): number => options.now?.() ?? Date.now();
    const threshold = (): number => options.thresholdMs ?? DEFAULT_IDLE_EXIT_MS;

    const disarm = (): void => {
        if (timer) clearTimeout(timer);
        timer = undefined;
    };

    const arm = (): void => {
        disarm();
        timer = setTimeout(() => {
            // `arm` and `check` are mutually recursive (arm schedules check via setTimeout; check re-arms itself
            // after a deferral), so one of the two must reference the other before its declaration.
            // eslint-disable-next-line no-void, no-use-before-define, @typescript-eslint/no-use-before-define -- the timer callback cannot await; `check` owns its own failure handling
            void check();
        }, threshold());
        timer.unref();
    };

    const check = async (): Promise<void> => {
        if (isStopped || idleSinceMs === undefined || connectionCount > 0) return;
        const idleDurationMs = now() - idleSinceMs;
        let isBusy: boolean;
        try {
            isBusy = await options.isBusy();
        } catch {
            isBusy = true;
        }
        // A connection may have arrived, or Core may have started stopping for another reason, while `isBusy` awaited.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- isStopped can change while options.isBusy() is awaited above
        if (isStopped || connectionCount > 0) return;
        if (isBusy) {
            deferralCount += 1;
            const reason: ServerIdleExitDeferralReason = 'active-pty';
            options.logger?.write('info', logEventCatalog.serverCore.idleExitDeferred, {
                fields: { deferralCount, idleDurationMs, reason },
            });
            arm();
            return;
        }
        options.onIdleExit({ deferralCount, idleDurationMs });
    };

    return {
        updateConnectionCount(count) {
            if (isStopped) return;
            connectionCount = count;
            if (count > 0) {
                idleSinceMs = undefined;
                deferralCount = 0;
                disarm();
                return;
            }
            // Only the nonzero->zero transition starts the idle clock and arms the timer. A repeated zero report
            // (e.g. a transport re-announcing the same empty count) must not push the pending check back out to a
            // fresh full threshold, or a sufficiently chatty reporter could postpone exit indefinitely even though
            // the connection count has genuinely been zero the whole time.
            if (idleSinceMs !== undefined) return;
            idleSinceMs = now();
            arm();
        },
        stop() {
            isStopped = true;
            disarm();
        },
    };
}

export interface IdleExitConnectionTracker {
    /**
     * Binds the monitor once Server Core has finished starting, and immediately reports whatever aggregate this tracker
     * already observed (usually 0 this early, but a client may have raced its own connection ahead of this call).
     */
    bind(monitor: IdleExitMonitor): void;
    /**
     * Disarms the bound monitor, if any; safe to call before `bind`. Any other stop trigger (command, signal, Desktop
     * quit) makes a pending idle-exit check moot.
     */
    stop(): void;
    /**
     * Reports the current authenticated control-transport (Desktop, Agent, CLI) client count.
     */
    updateControlCount(count: number): void;
    /**
     * Reports the current authenticated Mobile connection count.
     */
    updateMobileCount(count: number): void;
}

/**
 * Aggregates the authenticated connection count across every transport (control clients plus Mobile) into the single
 * total `IdleExitMonitor` needs — see `server-core.ts`'s wiring. `ControlServer` and `MobileGateway` each report only
 * their own count; nothing else on this object cares which transport contributed it.
 */
export function createIdleExitConnectionTracker(): IdleExitConnectionTracker {
    let controlCount = 0;
    let mobileCount = 0;
    let monitor: IdleExitMonitor | undefined;
    const report = (): void => monitor?.updateConnectionCount(controlCount + mobileCount);
    return {
        bind(nextMonitor) {
            monitor = nextMonitor;
            report();
        },
        stop() {
            monitor?.stop();
        },
        updateControlCount(count) {
            controlCount = count;
            report();
        },
        updateMobileCount(count) {
            mobileCount = count;
            report();
        },
    };
}

/**
 * Internal override for `DEFAULT_IDLE_EXIT_MS`, forwarded from Desktop to Server Core the same way as the other
 * `CAXRI_*_MS` dev/test seams in `apps/desktop/src/main/server-connection.ts` (unconditionally, not gated behind
 * `CAXRI_E2E`, so `switch-worktree dev` live verification can use it too). There is no user-facing setting for this
 * value — see `DEFAULT_IDLE_EXIT_MS`'s rationale.
 */
export const IDLE_EXIT_ENVIRONMENT_KEY = 'CAXRI_SERVER_IDLE_EXIT_MS';
/**
 * Floor for the override: low enough for a fast live-verification loop, high enough that a mistyped `1` or `10` cannot
 * make Server Core exit before its own startup sequence finishes observing the first connection. Exported so tests can
 * reference the same value rather than duplicating the literal.
 */
export const MIN_IDLE_EXIT_MS = 1_000;

export function resolveIdleExitThresholdMs(environment: NodeJS.ProcessEnv): number | undefined {
    const source = environment[IDLE_EXIT_ENVIRONMENT_KEY];
    if (source === undefined) return undefined;
    const bounds = `${IDLE_EXIT_ENVIRONMENT_KEY} must be an integer of at least ${MIN_IDLE_EXIT_MS}`;
    if (!/^[1-9]\d*$/u.test(source)) throw new Error(bounds);
    const thresholdMs = Number(source);
    if (!Number.isSafeInteger(thresholdMs) || thresholdMs < MIN_IDLE_EXIT_MS)
        throw new Error(bounds);
    return thresholdMs;
}
