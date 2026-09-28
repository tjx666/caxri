import type { ProjectStatusState, ProjectStatusSummary } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, mapWithConcurrency } from '@caxri/system';

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

export interface DeliveryWatchOptions {
    clearTimer: (timer: NodeJS.Timeout) => void;
    isEnabled: () => boolean;
    listSessions: () => readonly string[];
    logger: StructuredLogger;
    selectedSessionId: () => string | undefined;
    setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    /**
     * The Session's latest cached summary, if any.
     */
    summaryOf: (sessionId: string) => ProjectStatusSummary | undefined;
    /**
     * Refreshes one Session unless `covered` already holds its delivery keys, adding them when it does not.
     */
    watchSession: (sessionId: string, covered: Set<string>) => Promise<WatchOutcome>;
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

    constructor(private readonly options: DeliveryWatchOptions) {}

    private schedule(delayMs: number): void {
        if (this.isDisposed) return;
        if (this.timer) this.options.clearTimer(this.timer);
        const timer = this.options.setTimer(() => {
            this.timer = undefined;
            // Fire-and-forget: `run` owns its own failure logging and re-arms the timer either way.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void this.run();
        }, delayMs);
        // Never hold the Server process open for a background refresh.
        timer.unref();
        this.timer = timer;
    }

    private async run(): Promise<void> {
        if (this.isRunning || this.isDisposed) return;
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
            const selected = this.options.selectedSessionId();
            /**
             * Seeded with what the selected Session's own poll already covers, so a background Session on the same
             * repository and branch costs nothing extra.
             */
            const covered = new Set<string>(
                deliveryKeys(selected ? this.options.summaryOf(selected) : undefined),
            );
            const sessionIds = this.options
                .listSessions()
                .filter((sessionId) => sessionId !== selected);
            await mapWithConcurrency(sessionIds, WATCH_CONCURRENCY, async (sessionId) => {
                try {
                    outcomes[await this.options.watchSession(sessionId, covered)] += 1;
                    if (isInFlight(this.options.summaryOf(sessionId))) hasInFlight = true;
                } catch {
                    outcomes.failed += 1;
                }
            });
        } finally {
            this.isRunning = false;
            this.options.logger.write('debug', logEventCatalog.projectStatus.watch, {
                durationMs: performance.now() - startedAt,
                fields: { ...outcomes, inFlight: hasInFlight },
            });
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
