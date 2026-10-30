import type { EditorWorkerStallDiagnostic } from '@caxri/protocol';

import type { EditorWorkerStartupSummary } from '../../../lib/monaco-worker-startup';
import { editorWorkerStartupSummary } from '../../../lib/monaco-worker-startup';
import type { WorkerRoundTripResult } from '../../../lib/worker-round-trip';
import { probeWorkerRoundTrip } from '../../../lib/worker-round-trip';

/**
 * A comparison past this budget needs an explicit incomplete state. Missing Worker replies are one possible cause; a
 * slow computation can still recover, so the timeout is not a permanent-failure diagnosis.
 */
const DIFF_STALL_TIMEOUT_MS = 8_000;

/**
 * Opening a repository's Changes view mounts one diff per changed file at once. Without a floor between reports, a
 * stalled Worker would write one record per file; with it, the aggregates below still carry the real volume.
 */
const MINIMUM_REPORT_INTERVAL_MS = 60_000;

interface DiffModelShape {
    originalLineCount: number;
    modifiedLineCount: number;
    identicalModels: boolean;
}

interface PageLoadShape {
    navigationType: EditorWorkerStallDiagnostic['navigationType'];
    pageAgeMs: number;
}

/**
 * Guards against a browser reporting a navigation type outside the set this diagnostic may carry, so an unexpected
 * value degrades to `unknown` instead of failing validation once it reaches the Main process.
 */
const NAVIGATION_TYPES = new Set<string>(['back-forward', 'navigate', 'prerender', 'reload']);

/**
 * The diagnostic contract's own ceilings, applied where the record is built so no source of a duration can push one out
 * of range. A window or a wait that outlives its ceiling is saturated rather than sent as-is, because an out-of-range
 * number costs the whole record, and a rejected record is exactly the silence this watcher exists to end.
 */
const MAXIMUM_PAGE_AGE_MS = 2_592_000_000;
const MAXIMUM_WAIT_MS = 600_000;

/**
 * A reload rebuilds the document but keeps the renderer process, which is why the failure behind issue #962 survived
 * reloads and only an app restart cleared it. Recording how this document was loaded, and how long ago, is what lets a
 * later reader tell a page that was broken from its first frame from one that degraded while running.
 */
function readPageLoad(): PageLoadShape {
    const entry = performance.getEntriesByType('navigation')[0] as
        PerformanceNavigationTiming | undefined;
    const type = entry?.type === 'back_forward' ? 'back-forward' : entry?.type;
    return {
        navigationType: type && NAVIGATION_TYPES.has(type) ? type : 'unknown',
        pageAgeMs: Math.round(performance.now()),
    };
}

export interface GitDiffStallWatchDependencies {
    reportDiagnostic: (diagnostic: EditorWorkerStallDiagnostic) => void;
    probeRoundTrip?: () => Promise<WorkerRoundTripResult>;
    readWorkerStartup?: () => EditorWorkerStartupSummary;
    isDocumentVisible?: () => boolean;
    readPageLoad?: () => PageLoadShape;
    now?: () => number;
    createDiagnosticId?: () => string;
    timeoutMs?: number;
    minimumReportIntervalMs?: number;
    /**
     * How much longer a stalled diff waits for its _original_ Worker before this watcher gives up on the passive path
     * and calls `onRecoveryDue`. Undefined (the default) keeps the wait unbounded: every existing caller that has not
     * opted in behaves exactly as before, which matters because a Worker whose startup was merely delayed, not dead, is
     * expected to still answer after this budget (see the module doc's "Debugger pauses" case in
     * `docs/editor-worker-stalls.md`). See issue #962.
     */
    recoveryGraceMs?: number;
}

/**
 * `computed` means this diff computation produced an answer, whether or not it had already been declared stalled;
 * `stalled` means it passed the timeout without one. A surface that shows the diff needs both, because until the answer
 * arrives "no highlights" and "no difference" are the same picture. See issue #978.
 *
 * `worker-not-started` is the internal label for a missing first reply, not proof the module body never ran. It lets
 * the surface explain the observed Worker silence separately from a comparison timeout. See issue #962.
 */
export type GitDiffComputationOutcome = 'computed' | 'stalled' | 'worker-not-started';

export interface GitDiffStallObservation {
    waitForDiff: () => Promise<unknown>;
    readModels: () => DiffModelShape | undefined;
    onOutcome?: (outcome: GitDiffComputationOutcome) => void;
    /**
     * Fires once, no earlier than `recoveryGraceMs` after a stall was first reported, if the diff still has not
     * answered by then, including on its own, which is what a merely slow Worker startup still gets to do first (see
     * the module doc). The caller's job here is the mechanical part this watcher cannot do itself: destroy and recreate
     * the stalled Worker, then ask Monaco to recompute. Absent whenever `recoveryGraceMs` is not configured, which
     * keeps every window that has not opted in waiting exactly as it always has.
     */
    onRecoveryDue?: () => void;
}

/**
 * Watches Git diff computations and records the ones that never finish.
 *
 * A Monaco diff whose Worker stops replying looks exactly like an unchanged file: no highlights, no alignment fillers,
 * two independently scrolling panes, and not one line in any log. This watcher converts that silence into a record
 * carrying the wait, the state of Worker messaging at the time, and per-lifetime counts, so the next occurrence can be
 * diagnosed from `desktop.jsonl` instead of a live debugger session. See issue #962.
 *
 * With `recoveryGraceMs` configured, a stall that still has not resolved after that extra wait is offered one more
 * transition: `worker-recreated`, recorded here, then `onRecoveryDue` to let the caller do the part this watcher
 * cannot: destroy and recreate the stalled Worker and ask Monaco to recompute. `diff-worker-recovery.ts` owns how many
 * times one diff surface may accept that offer before it has to ask the user instead.
 */
export class GitDiffStallWatch {
    private diffOpenCount = 0;
    private stallCount = 0;
    private lastReportAt: number | undefined;

    constructor(private readonly dependencies: GitDiffStallWatchDependencies) {}

    private shouldReport(at: number): boolean {
        const floor = this.dependencies.minimumReportIntervalMs ?? MINIMUM_REPORT_INTERVAL_MS;
        return this.lastReportAt === undefined || at - this.lastReportAt >= floor;
    }

    private report(
        observation: GitDiffStallObservation,
        outcome: EditorWorkerStallDiagnostic['outcome'],
        waitMs: number,
        roundTrip: WorkerRoundTripResult,
    ): void {
        // A diff surface can be torn down between the stall firing and this record being written; a disposed Monaco
        // model throws on read, and losing three shape fields must never cost the whole diagnostic.
        let models: DiffModelShape | undefined;
        try {
            models = observation.readModels();
        } catch {
            models = undefined;
        }
        const createDiagnosticId =
            this.dependencies.createDiagnosticId ?? (() => crypto.randomUUID());
        const isDocumentVisible =
            this.dependencies.isDocumentVisible ?? (() => document.visibilityState === 'visible');
        const startup = (this.dependencies.readWorkerStartup ?? editorWorkerStartupSummary)();
        const pageLoad = (this.dependencies.readPageLoad ?? readPageLoad)();
        this.dependencies.reportDiagnostic({
            kind: 'editor-worker-stall',
            diagnosticId: createDiagnosticId(),
            surface: 'git-diff',
            outcome,
            waitMs: Math.min(MAXIMUM_WAIT_MS, Math.max(0, waitMs)),
            workerRoundTrip: roundTrip.outcome,
            workerRoundTripMs: roundTrip.durationMs,
            workerBroadcast: roundTrip.broadcast,
            documentVisible: isDocumentVisible(),
            navigationType: pageLoad.navigationType,
            pageAgeMs: Math.min(MAXIMUM_PAGE_AGE_MS, Math.max(0, pageLoad.pageAgeMs)),
            originalLineCount: models?.originalLineCount ?? 0,
            modifiedLineCount: models?.modifiedLineCount ?? 0,
            identicalModels: models?.identicalModels ?? false,
            diffOpenCount: this.diffOpenCount,
            stallCount: this.stallCount,
            editorWorkersCreated: startup.created,
            editorWorkersStarted: startup.started,
            editorWorkersStartupStalled: startup.stalled,
            editorWorkersStartupStalledNow: startup.stalledNow,
        });
    }

    /**
     * Watches one diff surface for the lifetime of its editor. A surface the user navigated away from must stay silent,
     * so cancelling drops both a pending stall and a pending recovery.
     *
     * @returns The cancel function to call when the editor unmounts.
     */
    observe(observation: GitDiffStallObservation): () => void {
        const now = this.dependencies.now ?? (() => Date.now());
        const timeoutMs = this.dependencies.timeoutMs ?? DIFF_STALL_TIMEOUT_MS;
        const startedAt = now();
        this.diffOpenCount += 1;
        const cancellation = new AbortController();
        /**
         * Read through a call, never a property: narrowing a property to `false` would survive the awaits below and
         * silently drop every later cancellation check.
         */
        const isCancelled = (): boolean => cancellation.signal.aborted;
        const cancelled = new Promise<'cancelled'>((resolve) => {
            cancellation.signal.addEventListener('abort', () => resolve('cancelled'), {
                once: true,
            });
        });
        let timer: ReturnType<typeof setTimeout> | undefined;

        const stalled = new Promise<'stalled'>((resolve) => {
            timer = setTimeout(() => resolve('stalled'), timeoutMs);
        });
        const settled = (async (): Promise<'settled'> => {
            try {
                await observation.waitForDiff();
            } catch {
                // A rejected wait means the view model was torn down, which is a resolved outcome here, not a stall.
            }
            return 'settled';
        })();

        void (async (): Promise<void> => {
            const first = await Promise.race([settled, stalled]);
            if (timer !== undefined) clearTimeout(timer);
            if (isCancelled()) return;
            if (first === 'settled') {
                observation.onOutcome?.('computed');
                return;
            }
            this.stallCount += 1;
            /**
             * The surface is told first, and unconditionally. The rate limit below bounds how often a stall is written
             * to the log; it must never decide whether the user is told that this diff did not compute, because the
             * alternative is a screen that reads as "no changes". See issue #978.
             */
            const startup = (this.dependencies.readWorkerStartup ?? editorWorkerStartupSummary)();
            const stallOutcome = startup.stalledNow > 0 ? 'worker-not-started' : 'stalled';
            observation.onOutcome?.(stallOutcome);
            // Rate-limited stalls still advance `stallCount`, so the next record that does go out carries the real
            // volume rather than implying a single occurrence.
            const isReported = this.shouldReport(now());
            if (isReported) {
                const roundTrip = await (
                    this.dependencies.probeRoundTrip ?? probeWorkerRoundTrip
                )();
                if (isCancelled()) return;
                this.lastReportAt = now();
                this.report(observation, 'timeout', Math.round(now() - startedAt), roundTrip);
            }
            if (isCancelled()) return;
            /**
             * `graceElapsed` is unset by default, so a window that has not opted into `recoveryGraceMs` races only
             * `settled` and `cancelled` in effect: a `Promise` that never resolves cannot win a race, so this stays
             * behaviorally identical to before `recoveryGraceMs` existed. Configured, it gives the _original_ Worker
             * one more window to answer on its own (a merely delayed startup still can, see the module doc's "Debugger
             * pauses" case) before this watcher gives up on it and offers the caller a recovery.
             *
             * Racing `cancelled` here matters for retention rather than correctness: a diff that never settles would
             * otherwise keep its Monaco models reachable through this continuation for as long as the window lives.
             */
            const recoveryGraceMs = this.dependencies.recoveryGraceMs;
            let graceTimer: ReturnType<typeof setTimeout> | undefined;
            const graceElapsed = new Promise<'grace-elapsed'>((resolve) => {
                if (recoveryGraceMs === undefined) return;
                graceTimer = setTimeout(() => resolve('grace-elapsed'), recoveryGraceMs);
            });
            const second = await Promise.race([settled, cancelled, graceElapsed]);
            if (graceTimer !== undefined) clearTimeout(graceTimer);
            if (second === 'cancelled') return;
            if (second === 'grace-elapsed') {
                // The active counterpart to `recovered` below: instead of the original stalled Worker answering late
                // on its own, the caller is about to destroy and recreate it and ask Monaco to recompute. Recorded
                // before `onRecoveryDue`, and under the same rate limit as the `timeout` it follows: opening a
                // Changes view full of stalled diffs must not write one `worker-recreated` line per file; but every
                // stalled surface still gets to recover, because that is a correctness fix, not a log write.
                if (isReported)
                    this.report(observation, 'worker-recreated', Math.round(now() - startedAt), {
                        outcome: 'skipped',
                        durationMs: null,
                        broadcast: 'skipped',
                    });
                observation.onRecoveryDue?.();
                return;
            }
            observation.onOutcome?.('computed');
            if (!isReported) return;
            this.report(observation, 'recovered', Math.round(now() - startedAt), {
                outcome: 'skipped',
                durationMs: null,
                broadcast: 'skipped',
            });
        })();

        return () => {
            cancellation.abort();
            if (timer !== undefined) clearTimeout(timer);
        };
    }
}

/**
 * One watcher per window: the counts it reports are per-lifetime aggregates, which only mean anything when every diff
 * surface shares them.
 *
 * `recoveryGraceMs` reuses the same budget as the initial stall timeout: a Worker whose startup was merely delayed gets
 * one full comparison budget to answer on its own before this window offers `onRecoveryDue`, the same generosity
 * `DIFF_STALL_TIMEOUT_MS` already gives every diff's first attempt.
 */
export const gitDiffStallWatch = new GitDiffStallWatch({
    reportDiagnostic: (diagnostic) => globalThis.caxri.reportDiagnostic(diagnostic),
    recoveryGraceMs: DIFF_STALL_TIMEOUT_MS,
});
