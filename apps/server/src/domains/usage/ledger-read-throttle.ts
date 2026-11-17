import type { CaxriDatabase } from '../db';

/**
 * How long after a completed ledger sync the per-Session and plan-limit reads answer from the stored rows instead of
 * starting another pass. A pass locates and stats every ledger row's transcript, and the ledger is never pruned, so its
 * cost grows with total history; the sidebar cards, the Delegated Sessions strip, and phone clients each read once per
 * Session and would otherwise repeat that full pass per read. A running Agent Session's transcript is at most this
 * stale on those surfaces; the Usage report always syncs.
 *
 * Matches the sidebar card's 30s query stale time. At 5s, with a pass taking 5 to 20s and a card read every few
 * seconds, passes still ran nearly back to back on a long history, stalled Server Core, and filled the per-client
 * admission limit until view reads failed with `CAPACITY`.
 */
export const LEDGER_READ_MIN_INTERVAL_MS = 30_000;

/**
 * A ledger pass slower than this is logged at info instead of debug, so a history that has outgrown the pass shows up
 * without enabling debug logs.
 */
const SLOW_SCAN_LOG_MS = 1_000;

interface LedgerReadDependencies {
    isRunning: () => boolean;
    ledger: CaxriDatabase['agentSessionUsage'];
    now: () => number;
    sync: () => Promise<void>;
}

/**
 * Decides whether a per-Session or plan-limit read may skip the ledger pass because one just finished.
 */
export class LedgerReadThrottle {
    private completedAt?: number;
    /**
     * Ledger rows the last pass started with; a larger ledger holds a binding no pass has scanned.
     */
    private rowsAtLastPass = 0;
    private skipped = 0;

    constructor(private readonly dependencies: LedgerReadDependencies) {}

    private hasUnseenRows(now: number): boolean {
        const { ledger } = this.dependencies;
        ledger.recordBindings(undefined, now);
        return ledger.list().length > this.rowsAtLastPass;
    }

    /**
     * Per-lifetime count of reads answered from stored rows because a pass had just finished.
     */
    get skippedReads(): number {
        return this.skipped;
    }

    passStarted(rowCount: number): void {
        this.rowsAtLastPass = rowCount;
    }

    passCompleted(now: number): void {
        this.completedAt = now;
    }

    /**
     * Answers a read from the stored rows when a pass finished within the interval and the ledger holds no row that
     * pass has not seen; otherwise runs `sync`. A running pass is always joined (so `isScanPending` stays truthful).
     * The ledger's current bindings are recorded first and its size is compared with the last pass's count, not with
     * the count before the call, because a Terminal records its own binding the moment it binds, so the row may already
     * exist yet never have been scanned.
     */
    async read(): Promise<void> {
        const { isRunning, now, sync } = this.dependencies;
        if (!isRunning()) {
            const current = now();
            const elapsed = this.completedAt === undefined ? Infinity : current - this.completedAt;
            // A clock that moved backward counts as expired.
            const isRecent = elapsed >= 0 && elapsed < LEDGER_READ_MIN_INTERVAL_MS;
            if (isRecent && !this.hasUnseenRows(current)) {
                this.skipped += 1;
                return;
            }
        }
        await sync();
    }
}

/**
 * `warn` for a pass that failed to read a transcript, `info` for a slow one, else `debug`.
 */
export function scanLogLevel(failed: number, durationMs: number): 'warn' | 'info' | 'debug' {
    if (failed > 0) return 'warn';
    return durationMs > SLOW_SCAN_LOG_MS ? 'info' : 'debug';
}
