import type { EditorWorkerStallDiagnostic } from '@caxri/protocol';

import { editorWorkersCreated } from '../../lib/monaco-worker-count';
import type { WorkerRoundTripResult } from '../../lib/worker-round-trip';
import { probeWorkerRoundTrip } from '../../lib/worker-round-trip';

/**
 * A diff that has not resolved by this point is not "slow": Monaco's own computation budget is well under a second even
 * for large files, so the remaining explanation is a Worker that will never answer.
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

export interface GitDiffStallWatchDependencies {
    reportDiagnostic: (diagnostic: EditorWorkerStallDiagnostic) => void;
    probeRoundTrip?: () => Promise<WorkerRoundTripResult>;
    countEditorWorkers?: () => number;
    isDocumentVisible?: () => boolean;
    now?: () => number;
    createDiagnosticId?: () => string;
    timeoutMs?: number;
    minimumReportIntervalMs?: number;
}

export interface GitDiffStallObservation {
    waitForDiff: () => Promise<unknown>;
    readModels: () => DiffModelShape | undefined;
}

/**
 * Watches Git diff computations and records the ones that never finish.
 *
 * A Monaco diff whose Worker stops replying looks exactly like an unchanged file: no highlights, no alignment fillers,
 * two independently scrolling panes, and not one line in any log. This watcher converts that silence into a record
 * carrying the wait, the state of Worker messaging at the time, and per-lifetime counts, so the next occurrence can be
 * diagnosed from `desktop.jsonl` instead of a live debugger session. See issue #962.
 *
 * It only observes. Recovering a stalled Worker is deliberately out of scope here.
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
        const countEditorWorkers = this.dependencies.countEditorWorkers ?? editorWorkersCreated;
        this.dependencies.reportDiagnostic({
            kind: 'editor-worker-stall',
            diagnosticId: createDiagnosticId(),
            surface: 'git-diff',
            outcome,
            waitMs: Math.max(0, waitMs),
            workerRoundTrip: roundTrip.outcome,
            workerRoundTripMs: roundTrip.durationMs,
            documentVisible: isDocumentVisible(),
            originalLineCount: models?.originalLineCount ?? 0,
            modifiedLineCount: models?.modifiedLineCount ?? 0,
            identicalModels: models?.identicalModels ?? false,
            diffOpenCount: this.diffOpenCount,
            stallCount: this.stallCount,
            editorWorkersCreated: countEditorWorkers(),
        });
    }

    /**
     * @returns A cancel function to call when the editor unmounts, so a diff the user navigated away from cannot report
     *   a recovery for a surface that no longer exists.
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

        // eslint-disable-next-line no-void -- this watcher owns its observation and never reports failures upward.
        void (async (): Promise<void> => {
            const first = await Promise.race([settled, stalled]);
            if (timer !== undefined) clearTimeout(timer);
            if (first === 'settled' || isCancelled()) return;
            this.stallCount += 1;
            // Rate-limited stalls still advance `stallCount`, so the next record that does go out carries the real
            // volume rather than implying a single occurrence.
            if (!this.shouldReport(now())) return;
            const roundTrip = await (this.dependencies.probeRoundTrip ?? probeWorkerRoundTrip)();
            if (isCancelled()) return;
            this.lastReportAt = now();
            this.report(observation, 'timeout', Math.round(now() - startedAt), roundTrip);
            // A reported stall that later produces its diff is the transition worth recording: it separates a Worker
            // that was merely slow from one that never came back. Racing cancellation matters for retention rather
            // than correctness: a diff that never settles would otherwise keep its Monaco models reachable through
            // this continuation for as long as the window lives.
            if ((await Promise.race([settled, cancelled])) !== 'settled') return;
            this.report(observation, 'recovered', Math.round(now() - startedAt), {
                outcome: 'skipped',
                durationMs: null,
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
 */
export const gitDiffStallWatch = new GitDiffStallWatch({
    reportDiagnostic: (diagnostic) => globalThis.caxri.reportDiagnostic(diagnostic),
});
