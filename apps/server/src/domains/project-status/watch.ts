import type { ProjectStatusState, ProjectStatusSummary } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, mapWithConcurrency } from '@caxri/system';

import { runAsBackgroundWork } from '../../observability/background-work';
import type { BackgroundLoadGate } from '../../observability/machine-load';
import { machineLoad } from '../../observability/machine-load';
import type { SummaryCacheEntry } from './carry-over';

/**
 * The states that make a snapshot worth re-asking for on the short window.
 */
const IN_FLIGHT_STATES = new Set<ProjectStatusState>(['pending', 'queued']);
/**
 * Cadence of the delivery watch over every other Session. Slower than the selected Session's poll because nobody is
 * looking at these panels; it exists so a failure is noticed at all. A round with a build or check still running comes
 * back sooner, since that is exactly when a failure is about to land.
 */
const WATCH_PENDING_DELAY_MS = 60_000;
const WATCH_SETTLED_DELAY_MS = 3 * 60_000;
/**
 * Background Sessions refresh two at a time so a long Session list cannot burst the shared `gh`/`vc` budget.
 */
const WATCH_CONCURRENCY = 2;

/**
 * What one background Session contributed to a delivery-watch round, aggregated per round so the log shows how much of
 * the Session list actually cost a `gh`/`vc` refresh.
 */
export type WatchOutcome = 'duplicate' | 'failed' | 'fresh' | 'refreshed' | 'skipped';

/**
 * State shared by the Sessions of one delivery-watch round.
 */
export interface WatchRound {
    /**
     * Delivery keys a Session earlier in the round (or a resident poll) already refreshed.
     */
    covered: Set<string>;
    /**
     * Tracking-ref reads keyed by repository root and branch. Every Session reads its tracking ref before it can learn
     * that another Session covered the same delivery, so Sessions sharing a checkout re-ran the same `for-each-ref`
     * (production: 19 identical reads per round for one root, about half of all logged Git commands).
     */
    trackingHeads: Map<string, Promise<string>>;
}

/**
 * Identity of the delivery a repository reports: two Sessions with equal keys would fetch, and alert on, the same
 * checks and deployments.
 */
export function deliveryKeys(summary: ProjectStatusSummary | undefined): string[] {
    return (summary?.repositories ?? [])
        .filter((repo) => repo.githubUrl && repo.branch)
        .map((repo) => `${repo.githubUrl}@${repo.branch}`);
}

/**
 * Whether anything in `summary` is still running, which is what earns a shorter revisit.
 */
export function isInFlight(summary: ProjectStatusSummary | undefined): boolean {
    return (summary?.repositories ?? []).some(
        (repo) =>
            IN_FLIGHT_STATES.has(repo.pullRequest?.state ?? 'unknown') ||
            IN_FLIGHT_STATES.has(repo.deployments?.production?.state ?? 'unknown') ||
            IN_FLIGHT_STATES.has(repo.deployments?.preview?.state ?? 'unknown'),
    );
}

/**
 * Whether a background Session's cached summary still answers this round, given the fingerprint of its local inputs.
 *
 * Any entry is fresh until its TTL lapses. A round armed on the pending delay exists for the Sessions that are still
 * running, so it also leaves a settled Session alone until the settled cadence comes round. Without that, every other
 * Session whose 2-minute TTL had lapsed was refreshed with it, and one running build anywhere moved the whole list from
 * the settled 3-minute cadence to every 2 minutes (production: about 21,000 `vc` calls in 11 hours). Only an entry
 * whose fingerprint still matches qualifies, so a new HEAD or branch is never deferred; `expiresAt > 0` excludes a
 * carried entry, whose `refreshedAt` is local while its delivery data is stale.
 */
export function isWatchFresh(
    previous: SummaryCacheEntry | undefined,
    fingerprint: string,
    now: number,
    isPendingRound: boolean,
): boolean {
    if (previous?.fingerprint !== fingerprint || previous.expiresAt <= 0) return false;
    if (previous.expiresAt > now) return true;
    if (!isPendingRound || !previous.value || isInFlight(previous.value)) return false;
    return now - previous.value.refreshedAt < WATCH_SETTLED_DELAY_MS;
}

export interface DeliveryWatchOptions {
    clearTimer: (timer: NodeJS.Timeout) => void;
    isEnabled: () => boolean;
    listSessions: () => readonly string[];
    /**
     * A round that finds the machine loaded is skipped and retried on the pending delay.
     */
    load?: BackgroundLoadGate;
    logger: StructuredLogger;
    /**
     * The Sessions the resident poll already covers (the visible ones); the background watch skips them.
     */
    polledSessionIds: () => ReadonlySet<string>;
    setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    /**
     * The Session's latest cached summary, if any.
     */
    summaryOf: (sessionId: string) => ProjectStatusSummary | undefined;
    /**
     * Refreshes one Session unless `round.covered` already holds its delivery keys, adding them when it does not.
     * `isPendingRound` lets a settled Session whose local inputs did not change sit the round out (see
     * {@link isWatchFresh}).
     */
    watchSession: (
        sessionId: string,
        round: WatchRound,
        isPendingRound: boolean,
    ) => Promise<WatchOutcome>;
}

/**
 * Keeps delivery failures observable for every Session, not only the selected one.
 *
 * The selected Session's poll keeps the Status panel warm; this watch exists only so a Session the user switched away
 * from still raises its CI or deployment failure through the alert tracker. A round is skipped entirely while delivery
 * notifications are disabled, because nothing else consumes what it would fetch.
 */
export class DeliveryWatch {
    private timer?: NodeJS.Timeout;
    private isRunning = false;
    private isDisposed = false;
    /**
     * Whether the round being run was armed on the short pending delay because the previous one saw a build or check
     * still running.
     */
    private isPendingRound = false;

    constructor(private readonly options: DeliveryWatchOptions) {}

    private schedule(delayMs: number): void {
        if (this.isDisposed) return;
        if (this.timer) this.options.clearTimer(this.timer);
        const timer = this.options.setTimer(() => {
            this.timer = undefined;
            // Fire-and-forget: `run` owns its own failure logging and re-arms the timer either way.
            void this.run();
        }, delayMs);
        // Never hold the Server process open for a background refresh.
        timer.unref();
        this.timer = timer;
    }

    private async run(): Promise<void> {
        if (this.isRunning || this.isDisposed) return;
        const { load = machineLoad } = this.options;
        if (load.shouldDefer('delivery-watch')) {
            this.schedule(WATCH_PENDING_DELAY_MS);
            return;
        }
        this.isRunning = true;
        const startedAt = performance.now();
        const outcomes: Record<WatchOutcome, number> = {
            duplicate: 0,
            failed: 0,
            fresh: 0,
            refreshed: 0,
            skipped: 0,
        };
        // Widened explicitly: TypeScript does not see the assignment inside the callback and would narrow to `false`.
        let hasInFlight = false as boolean;
        try {
            if (!this.options.isEnabled()) return;
            const polled = this.options.polledSessionIds();
            /**
             * Seeded with what the polled Sessions' own polls already cover, so a background Session on the same
             * repository and branch costs nothing extra.
             */
            const covered = new Set<string>(
                [...polled].flatMap((sessionId) => deliveryKeys(this.options.summaryOf(sessionId))),
            );
            const round: WatchRound = { covered, trackingHeads: new Map() };
            const sessionIds = this.options
                .listSessions()
                .filter((sessionId) => !polled.has(sessionId));
            await runAsBackgroundWork('delivery-watch', () =>
                mapWithConcurrency(sessionIds, WATCH_CONCURRENCY, async (sessionId) => {
                    try {
                        const outcome = await this.options.watchSession(
                            sessionId,
                            round,
                            this.isPendingRound,
                        );
                        outcomes[outcome] += 1;
                        if (isInFlight(this.options.summaryOf(sessionId))) hasInFlight = true;
                    } catch {
                        outcomes.failed += 1;
                    }
                }),
            );
        } finally {
            this.isRunning = false;
            this.options.logger.write('debug', logEventCatalog.projectStatus.watch, {
                durationMs: performance.now() - startedAt,
                fields: { ...outcomes, inFlight: hasInFlight },
            });
            this.isPendingRound = hasInFlight;
            this.schedule(hasInFlight ? WATCH_PENDING_DELAY_MS : WATCH_SETTLED_DELAY_MS);
        }
    }

    start(): void {
        this.schedule(WATCH_SETTLED_DELAY_MS);
    }

    dispose(): void {
        this.isDisposed = true;
        if (!this.timer) return;
        this.options.clearTimer(this.timer);
        this.timer = undefined;
    }
}
