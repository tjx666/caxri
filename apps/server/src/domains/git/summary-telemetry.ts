import { createHash } from 'node:crypto';

import type { GitSummary } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { countFields } from '../log-count-fields';
import type { GitSummaryRequester } from './summary-trace';

/**
 * Steady-state window for one `git.refresh_summary` record per Session. Production evidence (#604): `git.summary` wrote
 * 3008 records in one 5MB generation, and 79% of consecutive records repeated the previous result. One aggregate per
 * minute of activity keeps the volume, the change ratio, and the slowest refresh visible at a bounded cost.
 */
const GIT_SUMMARY_WINDOW_MS = 60_000;

export interface GitSummaryProductionFields {
    readonly commandCount: number;
    readonly reason: 'request' | 'refresh';
    readonly requester: GitSummaryRequester;
    readonly statusCoalesced: number;
    readonly statusFresh: number;
    readonly statusJoined: number;
}

interface SummaryWindow {
    changed: number;
    commandCount: number;
    joined: number;
    /**
     * Joined reads per entry point; these replace the per-call `git.summary` `joined` records.
     */
    readonly joinedRequesters: Map<string, number>;
    /**
     * Timestamp of the last refresh counted here, so the published duration covers activity, not idle time.
     */
    lastEventAt: number;
    maxDurationMs: number;
    queued: number;
    /**
     * Queued forced refreshes that joined an already queued trailing run rather than arming one.
     */
    queuedShared: number;
    /**
     * Queued forced refreshes per entry point.
     */
    readonly queuedRequesters: Map<string, number>;
    readonly reasons: Map<string, number>;
    refreshes: number;
    /**
     * Productions per entry point; `joined` and `queued` are totals so the two can be told apart.
     */
    readonly requesters: Map<string, number>;
    startedAt: number;
    statusCoalesced: number;
    statusFresh: number;
    statusJoined: number;
    totalDurationMs: number;
}

function newWindow(startedAt: number): SummaryWindow {
    return {
        changed: 0,
        commandCount: 0,
        joined: 0,
        joinedRequesters: new Map(),
        lastEventAt: startedAt,
        maxDurationMs: 0,
        queued: 0,
        queuedShared: 0,
        queuedRequesters: new Map(),
        reasons: new Map(),
        refreshes: 0,
        requesters: new Map(),
        startedAt,
        statusCoalesced: 0,
        statusFresh: 0,
        statusJoined: 0,
        totalDurationMs: 0,
    };
}

function increment(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Everything a refresh result exposes to the Renderer: the per-repository headline (branch, head, ahead/behind, totals,
 * truncation) plus a digest of the working-tree file list, so a change that keeps every count but swaps which files are
 * dirty still counts as a state transition. Branch names and paths never reach the log through this value; the
 * fingerprint is compared, not written.
 */
function fingerprint(summary: GitSummary): string {
    if (!summary.isRepository) return `none:${summary.error ?? ''}`;
    return summary.repositories
        .map((repo) => {
            const files = createHash('sha256');
            const entries = repo.files
                .map(
                    ({ path, kind, index, workingTree }) =>
                        `${path}|${kind}|${index}|${workingTree}`,
                )
                .toSorted((left, right) => left.localeCompare(right));
            for (const entry of entries) files.update(entry).update('\n');
            const headline = `${repo.id}|${repo.kind}|${repo.branch}|${repo.head ?? ''}|${repo.ahead}|${repo.behind}`;
            const totals = `${repo.additions}|${repo.deletions}|${repo.changedFileCount}|${repo.truncated}`;
            return `${headline}|${totals}|${files.digest('hex')}`;
        })
        .toSorted((left, right) => left.localeCompare(right))
        .join('\n');
}

/**
 * Owns what the Git summary boundary records about itself. Two audiences pull in opposite directions: explaining one
 * user-visible state needs the exact `git.summary` record that produced it, while noticing an unreported refresh storm
 * needs totals and worst-case durations across many refreshes. Per-refresh records therefore stay at `info` only when
 * the result differs from the previous one for that Session (so every branch switch or file change is still visible),
 * repeats drop to `debug`, and one `git.refresh_summary` per Session per window restores the volume and durations.
 *
 * Windows close lazily on the next refresh after the window elapsed, on Session eviction, and on Server close; there is
 * no timer, so an idle Session costs nothing and a Session that stops refreshing publishes its last window on
 * eviction.
 */
export class GitSummaryTelemetry {
    private readonly fingerprints = new Map<string, string>();
    private readonly windows = new Map<string, SummaryWindow>();

    constructor(
        private readonly logger: StructuredLogger,
        private readonly windowMs = GIT_SUMMARY_WINDOW_MS,
        private readonly now: () => number = Date.now,
    ) {}

    private window(sessionId: string): SummaryWindow {
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
     * `durationMs` spans the first to the last refresh counted in the window rather than to the moment the window was
     * closed, so a burst followed by hours of idling still reads as a burst.
     */
    private publish(sessionId: string, window: SummaryWindow): void {
        this.logger.write('info', logEventCatalog.git.refreshSummary, {
            durationMs: window.lastEventAt - window.startedAt,
            fields: {
                sessionId,
                refreshes: window.refreshes,
                changed: window.changed,
                repeated: window.refreshes - window.changed,
                joined: window.joined,
                queued: window.queued,
                queuedShared: window.queuedShared,
                commandCount: window.commandCount,
                statusFresh: window.statusFresh,
                statusJoined: window.statusJoined,
                statusCoalesced: window.statusCoalesced,
                totalDurationMs: window.totalDurationMs,
                maxDurationMs: window.maxDurationMs,
                ...countFields('reason', window.reasons),
                ...countFields('requester', window.requesters),
                ...countFields('joined', window.joinedRequesters),
                ...countFields('queued', window.queuedRequesters),
            },
        });
    }

    /**
     * Records one plain read that joined the in-flight production instead of running its own. It never spawned a Git
     * command, so it is only counted in the window aggregate; a per-call record repeated nothing the aggregate lacks.
     */
    recordJoined(sessionId: string, requester: GitSummaryRequester): void {
        const window = this.window(sessionId);
        window.joined += 1;
        increment(window.joinedRequesters, requester);
    }

    /**
     * Records one forced refresh that waits behind the in-flight producer (`shared` when it joined an already queued
     * trailing run). Counted per window so the aggregate still shows how many user refreshes were folded into one Git
     * batch. Like a joined read it is not written per call.
     */
    recordQueued(sessionId: string, requester: GitSummaryRequester, isShared: boolean): void {
        const window = this.window(sessionId);
        window.queued += 1;
        if (isShared) window.queuedShared += 1;
        increment(window.queuedRequesters, requester);
    }

    /**
     * Records one completed production in the window aggregate. Writes the `git.summary` record at `info` when the
     * result differs from the previous one for this Session (or is the first), at `debug` when it is unchanged but ran
     * Git commands, and not at all when it is unchanged and ran none.
     */
    recordProduced(
        sessionId: string,
        summary: GitSummary,
        durationMs: number,
        fields: GitSummaryProductionFields & Record<string, unknown>,
    ): void {
        const window = this.window(sessionId);
        const next = fingerprint(summary);
        const isChanged = this.fingerprints.get(sessionId) !== next;
        this.fingerprints.set(sessionId, next);
        window.refreshes += 1;
        if (isChanged) window.changed += 1;
        window.commandCount += fields.commandCount;
        window.statusFresh += fields.statusFresh;
        window.statusJoined += fields.statusJoined;
        window.statusCoalesced += fields.statusCoalesced;
        window.totalDurationMs += durationMs;
        window.maxDurationMs = Math.max(window.maxDurationMs, durationMs);
        increment(window.reasons, fields.reason);
        increment(window.requesters, fields.requester);
        /**
         * An unchanged production that ran no Git command (every status coalesced from cache) is fully described by the
         * window aggregate. Production wrote ~11,000 of these per 4 hours, a third of `server-core.jsonl`, rotating
         * real incidents out of the log.
         */
        if (!isChanged && fields.commandCount === 0) return;
        this.logger.write(isChanged ? 'info' : 'debug', logEventCatalog.git.summary, {
            durationMs,
            fields: { ...fields, changed: isChanged, outcome: 'fresh' },
        });
    }

    /**
     * Publishes and drops the open window for each Session, together with its last fingerprint, so a re-created Session
     * starts from a visible first record.
     */
    flush(sessionIds?: readonly string[]): void {
        const targets = sessionIds ?? this.windows.keys().toArray();
        for (const sessionId of targets) {
            const window = this.windows.get(sessionId);
            this.windows.delete(sessionId);
            this.fingerprints.delete(sessionId);
            if (window) this.publish(sessionId, window);
        }
    }
}
