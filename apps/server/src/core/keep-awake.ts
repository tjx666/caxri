import { spawn as nodeSpawn } from 'node:child_process';
import process from 'node:process';

import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

/**
 * What decides the hold, read fresh on every evaluation.
 */
export interface KeepAwakeDemand {
    /**
     * `power.keepAwakeWhileAgentsWork`.
     */
    isEnabled: boolean;
    /**
     * Sessions whose Agent runs a turn or compacts (`session.workSummary`).
     */
    working: number;
    /**
     * Chats waiting for a plan limit to reset, which continue on their own and so need the Mac awake too.
     */
    usageWaiting: number;
}

/**
 * Closed reason for `server_core.keep_awake_stopped`.
 */
type KeepAwakeStopReason = 'assertion-exited' | 'disabled' | 'server-stopping' | 'work-finished';

/**
 * The subset of a spawned child the controller drives, so tests need no real process.
 */
export interface KeepAwakeChild {
    kill(): boolean;
    once(event: 'error', listener: (error: Error) => void): unknown;
    once(event: 'exit', listener: (code: number | null) => void): unknown;
}

export interface KeepAwakeOptions {
    logger: Pick<StructuredLogger, 'write'>;
    /**
     * Resolves the current demand. A rejection keeps the current hold unchanged: a failed read must neither drop the
     * hold under working Agents nor start one nobody asked for.
     */
    readDemand: () => Promise<KeepAwakeDemand>;
    /**
     * Test seams; production uses the real platform, PID, clock, and `child_process.spawn`.
     */
    platform?: NodeJS.Platform;
    pid?: number;
    now?: () => number;
    spawn?: (command: string, arguments_: readonly string[]) => KeepAwakeChild;
}

export interface KeepAwakeController {
    /**
     * Re-evaluates soon. Calls within {@link KEEP_AWAKE_COALESCE_MS} share one read, so a burst of state changes from
     * many Agents costs a single summary.
     */
    schedule(): void;
    status(): { active: boolean; since?: number };
    /**
     * Releases the hold and disarms every timer; idempotent. Called once Server Core starts stopping.
     */
    stop(): void;
}

/**
 * How long a burst of state changes is coalesced into one evaluation.
 */
export const KEEP_AWAKE_COALESCE_MS = 500;

/**
 * The fallback re-evaluation interval. State events drive the hold; this only bounds how long a missed event (or a
 * failed read) can leave it wrong.
 */
const KEEP_AWAKE_RECHECK_MS = 60_000;

/**
 * First retry delay after the assertion failed; consecutive failures double it up to {@link KEEP_AWAKE_MAX_BACKOFF_MS}.
 */
export const KEEP_AWAKE_RETRY_MS = 30_000;
const KEEP_AWAKE_MAX_BACKOFF_MS = 16 * KEEP_AWAKE_RETRY_MS;

/**
 * `-i` prevents idle system sleep only: the display still turns off, so an unattended Mac spends almost nothing on the
 * screen. `-w <pid>` ties the assertion to Server Core's own process, so even a SIGKILLed Server Core cannot leave the
 * Mac awake forever. A closed lid on battery still sleeps; macOS offers no unprivileged assertion against that (Orca
 * documents the same limit).
 *
 * @see https://ss64.com/mac/caffeinate.html
 */
function caffeinateArguments(pid: number): string[] {
    return ['-i', '-w', String(pid)];
}

const CAFFEINATE_PATH = '/usr/bin/caffeinate';

function defaultSpawn(command: string, arguments_: readonly string[]): KeepAwakeChild {
    return nodeSpawn(command, arguments_, { stdio: 'ignore', shell: false });
}

function errorCode(error: unknown): string {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
        return error.code;
    return error instanceof Error ? error.name : 'unknown';
}

/**
 * Holds the Mac awake while Agents work, so a user who leaves Caxri running overnight finds the work done instead of
 * paused at the moment the Mac idled into sleep. Purely a Server Core concern: it keeps working with no Desktop
 * attached, which is exactly the unattended case.
 *
 * Evaluations run one at a time and always read the latest demand, so an older read never overrides a newer one.
 */
export function createKeepAwakeController(options: KeepAwakeOptions): KeepAwakeController {
    const platform = options.platform ?? process.platform;
    const pid = options.pid ?? process.pid;
    const now = options.now ?? Date.now;
    const spawn = options.spawn ?? defaultSpawn;
    const isSupported = platform === 'darwin';
    let child: KeepAwakeChild | undefined;
    let since: number | undefined;
    let peakWorking = 0;
    let consecutiveFailures = 0;
    let retryNotBefore = 0;
    let isStopped = false;
    const hasStopped = (): boolean => isStopped;
    let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
    let tail: Promise<void> = Promise.resolve();
    const recheckTimer = isSupported
        ? setInterval(() => schedule(), KEEP_AWAKE_RECHECK_MS)
        : undefined;
    recheckTimer?.unref();

    const recordFailure = (code: string): void => {
        consecutiveFailures += 1;
        const delay = Math.min(
            KEEP_AWAKE_RETRY_MS * 2 ** (consecutiveFailures - 1),
            KEEP_AWAKE_MAX_BACKOFF_MS,
        );
        retryNotBefore = now() + delay;
        options.logger.write('warn', logEventCatalog.serverCore.keepAwakeFailed, {
            fields: { errorCode: code, consecutiveFailures, retryInMs: delay },
        });
    };

    const release = (reason: KeepAwakeStopReason): void => {
        const current = child;
        if (!current || since === undefined) return;
        child = undefined;
        current.kill();
        options.logger.write('info', logEventCatalog.serverCore.keepAwakeStopped, {
            durationMs: now() - since,
            fields: { reason, peakWorking },
        });
        since = undefined;
        peakWorking = 0;
    };

    const acquire = (demand: KeepAwakeDemand): void => {
        if (now() < retryNotBefore) return;
        let started: KeepAwakeChild;
        try {
            started = spawn(CAFFEINATE_PATH, caffeinateArguments(pid));
        } catch (error) {
            recordFailure(errorCode(error));
            return;
        }
        child = started;
        since = now();
        peakWorking = demand.working;
        started.once('error', (error) => {
            if (child !== started) return;
            release('assertion-exited');
            recordFailure(errorCode(error));
        });
        started.once('exit', (code) => {
            // An exit we caused through `release` already cleared `child`.
            if (child !== started) return;
            release('assertion-exited');
            recordFailure(code === null ? 'signal' : `exit-${code}`);
            schedule();
        });
        options.logger.write('info', logEventCatalog.serverCore.keepAwakeStarted, {
            fields: { working: demand.working, usageWaiting: demand.usageWaiting },
        });
    };

    const evaluate = async (): Promise<void> => {
        if (isStopped || !isSupported) return;
        let demand: KeepAwakeDemand;
        try {
            demand = await options.readDemand();
        } catch {
            return;
        }
        // `stop` may have run while the read was in flight.
        if (hasStopped()) return;
        const shouldHold = demand.isEnabled && demand.working + demand.usageWaiting > 0;
        if (shouldHold && child) {
            peakWorking = Math.max(peakWorking, demand.working);
            consecutiveFailures = 0;
            return;
        }
        if (shouldHold) acquire(demand);
        else release(demand.isEnabled ? 'work-finished' : 'disabled');
    };

    function schedule(): void {
        if (isStopped || !isSupported || coalesceTimer) return;
        coalesceTimer = setTimeout(() => {
            coalesceTimer = undefined;
            const previous = tail;
            tail = (async () => {
                await previous;
                await evaluate();
            })();
        }, KEEP_AWAKE_COALESCE_MS);
        coalesceTimer.unref();
    }

    return {
        schedule,
        status: () => (since === undefined ? { active: false } : { active: true, since }),
        stop: () => {
            if (isStopped) return;
            isStopped = true;
            if (coalesceTimer) clearTimeout(coalesceTimer);
            if (recheckTimer) clearInterval(recheckTimer);
            release('server-stopping');
        },
    };
}
