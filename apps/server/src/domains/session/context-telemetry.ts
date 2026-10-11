import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { TranscriptScanFailureReason } from '../agents';
import { countFields } from '../log-count-fields';

/**
 * Steady-state window for one `session_context.scan_window` aggregate per Session. `SessionContextService` is polled
 * roughly once a minute per visible Session (the status bar's `projectStatus.overview` query, plus any Workbench Root
 * picker or pull-request sweep that joins the same in-flight read), so a per-poll record would repeat the same shape
 * `git.refresh_summary` was introduced to avoid for the sibling Git-summary path (issue #604). One aggregate per window
 * keeps the volume, worst-case duration, and approximate bytes scanned visible at a bounded cost.
 */
const SESSION_CONTEXT_WINDOW_MS = 60_000;

interface ScanWindow {
    bytesScanned: number;
    readonly failures: Map<TranscriptScanFailureReason, number>;
    lastEventAt: number;
    maxDurationMs: number;
    resets: number;
    scans: number;
    startedAt: number;
    totalDurationMs: number;
}

function newWindow(startedAt: number): ScanWindow {
    return {
        bytesScanned: 0,
        failures: new Map(),
        lastEventAt: startedAt,
        maxDurationMs: 0,
        resets: 0,
        scans: 0,
        startedAt,
        totalDurationMs: 0,
    };
}

function increment(
    counts: Map<TranscriptScanFailureReason, number>,
    key: TranscriptScanFailureReason,
): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Owns what `SessionContextService`'s incremental transcript scan records about itself (issue #1032). One immediate
 * record per failure and per cursor reset (the same shapes `GitSummaryTelemetry` uses for `git.summary`) keeps a
 * symlink rejection or a truncated transcript visible the moment it happens, while the per-Session, per-window
 * aggregate answers "how long did this path spend in the last minute" without a record on every poll.
 *
 * Windows close lazily on the next event after the window elapsed, on Session eviction, and on Server close; there is
 * no timer, so a Session nobody is looking at costs nothing.
 */
export class SessionContextTelemetry {
    private readonly windows = new Map<string, ScanWindow>();

    constructor(
        private readonly logger: StructuredLogger,
        private readonly windowMs = SESSION_CONTEXT_WINDOW_MS,
        private readonly now: () => number = Date.now,
    ) {}

    private window(sessionId: string): ScanWindow {
        const now = this.now();
        let current = this.windows.get(sessionId);
        if (current && now - current.startedAt >= this.windowMs) {
            this.publish(sessionId, current);
            current = undefined;
        }
        if (!current) {
            current = newWindow(now);
            this.windows.set(sessionId, current);
        }
        current.lastEventAt = now;
        return current;
    }

    /**
     * `durationMs` spans the first to the last scan counted in the window rather than to the moment the window was
     * closed, so a burst followed by idling still reads as a burst (mirrors `GitSummaryTelemetry.publish`).
     */
    private publish(sessionId: string, window: ScanWindow): void {
        this.logger.write('info', logEventCatalog.sessionContext.scanWindow, {
            durationMs: window.lastEventAt - window.startedAt,
            fields: {
                sessionId,
                scans: window.scans,
                resets: window.resets,
                totalDurationMs: Math.round(window.totalDurationMs),
                maxDurationMs: Math.round(window.maxDurationMs),
                bytesScanned: window.bytesScanned,
                ...countFields('failure', window.failures),
            },
        });
    }

    /**
     * Records one completed scan pass, successful or not, into the window aggregate. `bytesScanned` is the cursor's net
     * advance for this pass: exact for the common case, an undercount only when the pass also skipped a
     * per-record-oversized remainder or hit the 4 MiB per-poll ceiling, both already bounded and rare.
     */
    recordScan(sessionId: string, durationMs: number, bytesScanned: number): void {
        const window = this.window(sessionId);
        window.scans += 1;
        window.totalDurationMs += durationMs;
        window.maxDurationMs = Math.max(window.maxDurationMs, durationMs);
        window.bytesScanned += Math.max(0, bytesScanned);
    }

    /**
     * Records one scan pass that produced nothing. A `missing` transcript is the ordinary state before an Agent has
     * written its first line and every visible Session without one polls this path, so it is counted only in the window
     * aggregate. Every other reason is a security rejection or an IO failure, logged at `warn` immediately.
     */
    recordFailure(sessionId: string, reason: TranscriptScanFailureReason): void {
        increment(this.window(sessionId).failures, reason);
        if (reason === 'missing') return;
        this.logger.write('warn', logEventCatalog.sessionContext.scanFailed, {
            fields: { sessionId, reason },
        });
    }

    /**
     * Records the state transition when a rewritten transcript resets the cursor, immediately rather than only inside
     * the next window aggregate.
     */
    recordReset(sessionId: string): void {
        this.window(sessionId).resets += 1;
        this.logger.write('info', logEventCatalog.sessionContext.cursorReset, {
            fields: { sessionId },
        });
    }

    /**
     * Publishes and drops every open window, so a Server shutdown or a Session eviction still surfaces its last partial
     * window instead of losing it silently.
     */
    flush(sessionIds?: readonly string[]): void {
        const targets = sessionIds ?? this.windows.keys().toArray();
        for (const sessionId of targets) {
            const window = this.windows.get(sessionId);
            this.windows.delete(sessionId);
            if (window) this.publish(sessionId, window);
        }
    }
}
