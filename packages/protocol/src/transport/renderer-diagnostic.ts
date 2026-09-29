import { z } from 'zod';

import { identifierSchema } from '../domain/domain.js';
import {
    refineRendererPerformanceScenario,
    rendererPerformanceScenarioDiagnosticSchema,
} from './renderer-performance-diagnostic.js';

export const RENDERER_DIAGNOSTIC_CHANNEL = 'caxri:renderer-diagnostic';

/**
 * Content-free Renderer state that is safe to persist in local diagnostics. The strict schema is the privacy boundary:
 * terminal output, prompts, source text, DOM labels, and arbitrary error messages cannot cross this IPC channel.
 */
export const terminalRendererDiagnosticSchema = z.strictObject({
    kind: z.literal('terminal-renderer'),
    diagnosticId: z.uuid(),
    terminalId: identifierSchema,
    mode: z.enum(['dom', 'webgl']),
    reason: z.enum([
        'active',
        'context-loss',
        'context-loss-limit',
        'disabled',
        'disposed',
        'load-failed',
        /**
         * The pane belongs to a Session kept alive off screen, so its WebGL context was released on purpose. It is not
         * a failure and must never be counted as one: distinguishing it from `context-loss` is what keeps the GPU
         * incident budget meaningful once several Sessions hold live Terminals.
         */
        'suspended',
        'unsupported',
    ]),
    trigger: z.enum([
        'atlas-clear-failed',
        'dispose',
        'gpu-incident-limit',
        'gpu-process-recovery',
        'keep-alive-resume',
        'keep-alive-suspend',
        'preference-change',
        'manual-retry',
        'visibility-restore',
        'webgl-context-loss',
        'webgl-load-failed',
        'webgl-reprobe-succeeded',
        'webgl-retry-attempt',
        'webgl-retry-cancelled',
        'webgl-retry-deferred',
        'webgl-retry-exhausted',
        'webgl-retry-failed',
        'webgl-retry-scheduled',
        'webgl-retry-succeeded',
    ]),
    preference: z.enum(['auto', 'off', 'on']),
    contextLossCount: z.number().int().nonnegative().max(10_000),
    redrawCount: z.number().int().nonnegative().max(1_000_000),
    /**
     * Renderer-lifetime count of window focus, visibility, and pageshow events that were merged into an already
     * scheduled per-frame restore instead of running their own; the "cause" side of the visibility-restore trigger.
     */
    visibilityRestoreCoalescedCount: z.number().int().nonnegative().max(1_000_000),
    correlationId: z.uuid().optional(),
    recoveryResult: z.enum(['not-requested', 'already-dom', 'dom-restored', 'failed']),
    retryAttemptCount: z.number().int().nonnegative().max(3),
    retryDelayMs: z.number().int().nonnegative().max(60_000).nullable(),
    retryLimit: z.literal(3),
    retrySequenceId: z.uuid().optional(),
    retryState: z.enum([
        'cancelled',
        'deferred',
        'exhausted',
        'failed',
        'idle',
        'scheduled',
        'succeeded',
        'trying',
    ]),
    receivedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    droppedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    paneActive: z.boolean(),
    terminalProcessRunning: z.boolean(),
    agentTerminal: z.boolean(),
    documentVisible: z.boolean(),
    documentFocused: z.boolean(),
    terminalFocused: z.boolean(),
});

/**
 * One transition of the Renderer-session GPU incident budget. Per-pane `terminal-renderer` records only show each pane
 * settling under a pinned budget; this record is emitted once per session transition so a log can count how many times
 * the session converged on DOM and which incident or context-loss episode tripped it.
 */
export const gpuIncidentBudgetDiagnosticSchema = z.strictObject({
    kind: z.literal('gpu-incident-budget'),
    diagnosticId: z.uuid(),
    transition: z.enum(['pinned', 'reset']),
    cause: z.enum(['context-loss', 'gpu-incident', 'preference-change', 'manual-retry']),
    /**
     * Main-owned incident id when a `gpu.recoveryRequested` event tripped the budget.
     */
    correlationId: z.uuid().optional(),
    incidentCount: z.number().int().nonnegative().max(10_000),
    contextLossEpisodeCount: z.number().int().nonnegative().max(10_000),
    threshold: z.number().int().positive().max(100),
    /**
     * Preference the counts accrued under; for a `reset` this is the outgoing preference the session was pinned with.
     */
    preference: z.enum(['auto', 'off', 'on']).nullable(),
});

/**
 * Content-free context for a failed OSC 52 clipboard write. Error text, stack traces, clipboard payloads, and payload
 * sizes are intentionally excluded because Terminal-controlled values must never enter persisted diagnostics.
 */
export const terminalOsc52ClipboardWriteFailureDiagnosticSchema = z.strictObject({
    kind: z.literal('terminal-osc52-clipboard-write-failure'),
    diagnosticId: z.uuid(),
    terminalId: identifierSchema,
    errorCategory: z.enum([
        'abort',
        'error',
        'invalid-state',
        'non-error',
        'not-allowed',
        'other-dom-exception',
        'security',
    ]),
    clipboardWritePermission: z.enum([
        'denied',
        'granted',
        'prompt',
        'query-failed',
        'unavailable',
    ]),
    documentVisible: z.boolean(),
    documentFocused: z.boolean(),
    secureContext: z.boolean(),
    terminalFocused: z.boolean(),
    userActivationActive: z.boolean().nullable(),
    userActivationHasBeenActive: z.boolean().nullable(),
});

const terminalGridColumnsSchema = z.number().int().min(2).max(1_000);
const terminalGridRowsSchema = z.number().int().min(1).max(1_000);
const resizeBurstCountSchema = z.number().int().nonnegative().max(10_000);

export const terminalResizeBurstDiagnosticSchema = z.strictObject({
    kind: z.literal('terminal-resize-burst'),
    diagnosticId: z.uuid(),
    terminalId: identifierSchema,
    side: z.literal('renderer-xterm'),
    sampleCount: z.number().int().positive().max(10_000),
    /**
     * Grid transitions relative to the grid in force before the burst; `0` means the burst re-sampled the existing grid
     * and never changed it.
     */
    changeCount: resizeBurstCountSchema,
    startCols: terminalGridColumnsSchema,
    startRows: terminalGridRowsSchema,
    minCols: terminalGridColumnsSchema,
    minRows: terminalGridRowsSchema,
    maxCols: terminalGridColumnsSchema,
    maxRows: terminalGridRowsSchema,
    finalCols: terminalGridColumnsSchema,
    finalRows: terminalGridRowsSchema,
    durationMs: z.number().int().nonnegative().max(5_000),
    flushReason: z.enum(['disposed', 'max-duration', 'paused', 'quiet']),
    truncated: z.boolean(),
    localAppliedCount: resizeBurstCountSchema,
    requestCount: resizeBurstCountSchema,
});

const editorWorkerCountSchema = z.number().int().nonnegative().max(1_000_000);

/**
 * Monaco computes every diff in a Web Worker and the Renderer only paints the answer, so a Worker that stops replying
 * renders as a diff with no highlights, no alignment fillers, and two independently scrolling panes — with nothing
 * logged anywhere. This diagnostic turns that silent wait into a record: how long the diff waited, whether a minimal
 * echo Worker could still round-trip at that moment (which separates "Monaco's Worker died" from "this renderer stopped
 * delivering Worker messages at all"), and whether the diff eventually arrived after the stall was reported.
 *
 * Line counts and model identity are the only model-derived values; file contents, paths, and repository names are
 * deliberately absent so the channel stays content-free.
 */
export const editorWorkerStallDiagnosticSchema = z.strictObject({
    kind: z.literal('editor-worker-stall'),
    diagnosticId: z.uuid(),
    surface: z.literal('git-diff'),
    /**
     * `timeout` when the diff missed its budget, `recovered` when a previously reported stall produced its diff after
     * all on the _original_ Worker. Recording the transition — not only the failing state — is what makes a transient
     * stall distinguishable from a Worker that never comes back.
     *
     * `worker-recreated` is the active counterpart to `recovered`: the surface gave up waiting on the stalled Worker,
     * destroyed and recreated it, and asked Monaco to recompute. It is bounded to one automatic attempt per diff
     * surface (`git-diff-worker-recovery.ts`); a second stall on the same surface goes back through `timeout` and is
     * surfaced to the user instead of retried again on its own.
     */
    outcome: z.enum(['timeout', 'recovered', 'worker-recreated']),
    waitMs: z.number().int().nonnegative().max(600_000),
    workerRoundTrip: z.enum(['construct-failed', 'no-reply', 'ok', 'skipped', 'worker-error']),
    workerRoundTripMs: z.number().int().nonnegative().max(600_000).nullable(),
    /**
     * The same probe Worker answers a second time over a `BroadcastChannel`, which leaves the renderer and returns
     * brokered by the browser process. Read against `workerRoundTrip`, it separates three failures that otherwise look
     * identical: a Worker that never ran (both silent), a renderer that lost only its internal return path (`no-reply`
     * here but `ok` on the broadcast — the shape seen in issue #962), and healthy messaging with a slow diff (both
     * `ok`).
     */
    workerBroadcast: z.enum(['no-reply', 'ok', 'skipped', 'unsupported']),
    documentVisible: z.boolean(),
    /**
     * How the surrounding document was loaded, and how long it has been alive. A reloaded page keeps its renderer
     * process while a restart replaces it, which is why issue #962 survived reloads and only a restart recovered it;
     * recording both lets a reader tell "broken from the start" from "degraded while running".
     */
    navigationType: z.enum(['back-forward', 'navigate', 'prerender', 'reload', 'unknown']),
    pageAgeMs: z.number().int().nonnegative().max(2_592_000_000),
    originalLineCount: editorWorkerCountSchema,
    modifiedLineCount: editorWorkerCountSchema,
    identicalModels: z.boolean(),
    /**
     * Per-lifetime aggregates. A stall reported once and then deduplicated would leave its real volume unknowable, so
     * every record carries how many diffs this window opened and how many of them stalled.
     */
    diffOpenCount: editorWorkerCountSchema,
    stallCount: editorWorkerCountSchema,
    editorWorkersCreated: editorWorkerCountSchema,
    /**
     * How the Workers this window created actually behaved. `editorWorkersCreated` alone cannot separate "Monaco kept
     * asking and every Worker ran" from "Monaco kept asking and none of them ever did": both grow the same way. A
     * Worker counts as started once it has answered any message at all, which only a Worker whose script executed can
     * do, and as a startup stall once it has missed that budget without answering.
     */
    editorWorkersStarted: editorWorkerCountSchema,
    editorWorkersStartupStalled: editorWorkerCountSchema,
    /**
     * Workers still missing their first reply after the startup budget. This distinguishes observed Worker silence from
     * a slow comparison without asserting that the module body never executed.
     */
    editorWorkersStartupStalledNow: editorWorkerCountSchema,
});

function addAggregateIssue(context: z.core.$RefinementCtx<unknown>, path: string): void {
    context.addIssue({
        code: 'custom',
        message: 'Inconsistent resize burst aggregate',
        path: [path],
    });
}

/**
 * The Workbench's first visible frame after launch, reported once per page load so Desktop Main can close its startup
 * profile. Times are Renderer `performance.now()` values; `timeOriginEpochMs` lets Main rebase them onto its own clock,
 * which starts with the Main process.
 */
export const startupFrameDiagnosticSchema = z.strictObject({
    kind: z.literal('startup-frame'),
    diagnosticId: z.uuid(),
    timeOriginEpochMs: z.number().positive(),
    /**
     * When the pre-bundle `#startup-loader` was removed because the Workbench attached.
     */
    loaderRemovedMs: z.number().nonnegative().max(600_000),
    /**
     * Two animation frames after the loader removal, so the attached Workbench has actually been presented.
     */
    firstFrameMs: z.number().nonnegative().max(600_000),
    documentVisible: z.boolean(),
});

export const rendererDiagnosticSchema = z
    .discriminatedUnion('kind', [
        terminalRendererDiagnosticSchema,
        gpuIncidentBudgetDiagnosticSchema,
        terminalOsc52ClipboardWriteFailureDiagnosticSchema,
        terminalResizeBurstDiagnosticSchema,
        editorWorkerStallDiagnosticSchema,
        rendererPerformanceScenarioDiagnosticSchema,
        startupFrameDiagnosticSchema,
    ])
    .superRefine((diagnostic, context) => {
        if (diagnostic.kind === 'editor-worker-stall') {
            if (diagnostic.stallCount > diagnostic.diffOpenCount)
                addAggregateIssue(context, 'stallCount');
            // A late first reply contributes to both historical totals. Only currently stalled Workers are disjoint
            // from started Workers; rejecting that legitimate overlap would silently drop recovery diagnostics.
            if (
                diagnostic.editorWorkersStarted + diagnostic.editorWorkersStartupStalledNow >
                diagnostic.editorWorkersCreated
            )
                addAggregateIssue(context, 'editorWorkersStarted');
            if (diagnostic.editorWorkersStartupStalled > diagnostic.editorWorkersCreated)
                addAggregateIssue(context, 'editorWorkersStartupStalled');
            if (diagnostic.editorWorkersStartupStalledNow > diagnostic.editorWorkersStartupStalled)
                addAggregateIssue(context, 'editorWorkersStartupStalledNow');
            if (diagnostic.workerRoundTrip === 'ok' && diagnostic.workerRoundTripMs === null)
                addAggregateIssue(context, 'workerRoundTripMs');
            // The broadcast is only absent when nothing was probed at all; anything else must report what it observed,
            // because a `skipped` that really meant `no-reply` would erase the one contrast this record exists for.
            const isProbedNothing =
                diagnostic.workerRoundTrip === 'construct-failed' ||
                diagnostic.workerRoundTrip === 'skipped';
            if ((diagnostic.workerBroadcast === 'skipped') !== isProbedNothing)
                addAggregateIssue(context, 'workerBroadcast');
            return;
        }

        if (diagnostic.kind === 'terminal-resize-burst') {
            // A burst seeded from the grid in force before it began can report one transition per real sample
            // (seed -> sample 1 -> ... -> sample N), so changeCount may equal sampleCount but never exceed it.
            if (diagnostic.changeCount > diagnostic.sampleCount)
                addAggregateIssue(context, 'changeCount');
            if (diagnostic.localAppliedCount > diagnostic.sampleCount)
                addAggregateIssue(context, 'localAppliedCount');
            if (diagnostic.requestCount > diagnostic.sampleCount)
                addAggregateIssue(context, 'requestCount');

            for (const dimension of ['Cols', 'Rows'] as const) {
                const minimum = diagnostic[`min${dimension}`];
                const maximum = diagnostic[`max${dimension}`];
                if (minimum > maximum) addAggregateIssue(context, `min${dimension}`);
                for (const position of ['start', 'final'] as const) {
                    const value = diagnostic[`${position}${dimension}`];
                    if (value < minimum || value > maximum)
                        addAggregateIssue(context, `${position}${dimension}`);
                }
            }
            return;
        }

        if (diagnostic.kind === 'renderer-performance-scenario')
            refineRendererPerformanceScenario(diagnostic, context);
    });

export type TerminalRendererDiagnostic = z.infer<typeof terminalRendererDiagnosticSchema>;
export type GpuIncidentBudgetDiagnostic = z.infer<typeof gpuIncidentBudgetDiagnosticSchema>;
export type TerminalOsc52ClipboardWriteFailureDiagnostic = z.infer<
    typeof terminalOsc52ClipboardWriteFailureDiagnosticSchema
>;
export type TerminalResizeBurstDiagnostic = z.infer<typeof terminalResizeBurstDiagnosticSchema>;
export type EditorWorkerStallDiagnostic = z.infer<typeof editorWorkerStallDiagnosticSchema>;
export type StartupFrameDiagnostic = z.infer<typeof startupFrameDiagnosticSchema>;
export type RendererDiagnostic = z.infer<typeof rendererDiagnosticSchema>;
