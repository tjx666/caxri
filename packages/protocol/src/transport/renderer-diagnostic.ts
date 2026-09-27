import { z } from 'zod';

import { identifierSchema } from '../domain/domain.js';

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

const performanceDurationSchema = z.number().nonnegative().max(120_000);
const performanceCountSchema = z.number().int().nonnegative().max(1_000_000);
const percentileDurationSchema = z.number().nonnegative().max(120_000);
const reactProfileCountSchema = z.number().int().nonnegative().max(10_000);
const browserObserverCountSchema = z.number().int().nonnegative().max(2_000);

export const rendererPerformanceSurfaces = [
    'primary-sidebar',
    'workbench',
    'secondary-sidebar',
] as const;

const reactSurfacePerformanceSummarySchema = z.strictObject({
    profiledRenderCount: reactProfileCountSchema,
    actualDurationP50Ms: percentileDurationSchema,
    actualDurationP95Ms: percentileDurationSchema,
    actualDurationMaxMs: percentileDurationSchema,
    actualDurationTotalMs: performanceDurationSchema,
    baseDurationMaxMs: percentileDurationSchema,
});

const reactPerformanceSummarySchema = z.strictObject({
    commitCount: reactProfileCountSchema,
    profiledRenderCount: reactProfileCountSchema,
    mountRenderCount: reactProfileCountSchema,
    updateRenderCount: reactProfileCountSchema,
    nestedUpdateRenderCount: reactProfileCountSchema,
    actualDurationP50Ms: percentileDurationSchema,
    actualDurationP95Ms: percentileDurationSchema,
    actualDurationMaxMs: percentileDurationSchema,
    baseDurationMaxMs: percentileDurationSchema,
    surfaces: z.strictObject({
        'primary-sidebar': reactSurfacePerformanceSummarySchema,
        'workbench': reactSurfacePerformanceSummarySchema,
        'secondary-sidebar': reactSurfacePerformanceSummarySchema,
    }),
});

const longAnimationFrameSummarySchema = z.strictObject({
    count: browserObserverCountSchema,
    totalDurationMs: performanceDurationSchema,
    maxDurationMs: performanceDurationSchema,
    totalBlockingDurationMs: performanceDurationSchema,
    maxBlockingDurationMs: performanceDurationSchema,
    maxStyleAndLayoutDurationMs: performanceDurationSchema,
});

const interactionPerformanceSummarySchema = z.strictObject({
    count: browserObserverCountSchema,
    maxDurationMs: performanceDurationSchema,
    maxInputDelayMs: performanceDurationSchema,
    maxProcessingDurationMs: performanceDurationSchema,
    maxPresentationDelayMs: performanceDurationSchema,
});

const framePerformanceSummarySchema = z.strictObject({
    sampleCount: z.number().int().nonnegative().max(20_000),
    estimatedRefreshIntervalMs: z.number().nonnegative().max(100),
    intervalP50Ms: performanceDurationSchema,
    intervalP95Ms: performanceDurationSchema,
    maxIntervalMs: performanceDurationSchema,
    missedFrameCount: performanceCountSchema,
});

const requestPerformanceSummarySchema = z.strictObject({
    count: z.number().int().nonnegative().max(100),
    totalDurationMs: performanceDurationSchema,
    maxDurationMs: performanceDurationSchema,
});

/**
 * One Terminal mount stage aggregated over a scenario. The stages are measured separately because they have different
 * owners and different fixes: building xterm and its addons is Renderer cost, attaching WebGL is GPU cost, and
 * replaying the Server snapshot is a round trip. A single "Terminal took N ms" number cannot tell those apart.
 */
const terminalStagePerformanceSummarySchema = z.strictObject({
    count: z.number().int().nonnegative().max(1_000),
    totalDurationMs: performanceDurationSchema,
    maxDurationMs: performanceDurationSchema,
});

export const rendererPerformanceActions = ['session.switch'] as const;

/**
 * Bounded, content-free performance receipt emitted for one named Renderer scenario. It intentionally excludes
 * arbitrary labels, paths, DOM text, component props/state, stack traces, and source locations.
 */
export const rendererPerformanceScenarioDiagnosticSchema = z.strictObject({
    kind: z.literal('renderer-performance-scenario'),
    diagnosticId: z.uuid(),
    scenarioId: z.uuid(),
    entry: z.literal('workbench'),
    action: z.enum(rendererPerformanceActions),
    buildMode: z.enum(['development', 'production', 'profiling']),
    durationMs: performanceDurationSchema,
    documentVisible: z.boolean(),
    documentFocused: z.boolean(),
    visibilityInterrupted: z.boolean(),
    focusInterrupted: z.boolean(),
    capabilities: z.strictObject({
        longAnimationFrame: z.enum(['available', 'unavailable']),
        eventTiming: z.enum(['available', 'unavailable']),
        reactProfiler: z.enum(['available', 'disabled']),
    }),
    react: reactPerformanceSummarySchema,
    requests: z.strictObject({
        sessionSelect: requestPerformanceSummarySchema,
        appBootstrap: requestPerformanceSummarySchema,
    }),
    /**
     * What the Session switch actually cost in Terminal work. `reusedCount` is the whole point of the keep-alive: a
     * switch back to a retained Session should rebuild nothing, so a non-zero `stages.xtermCreate.count` beside a
     * non-zero `reusedCount` is the signature of a partially defeated cache rather than a healthy cold start.
     */
    terminals: z.strictObject({
        /**
         * Terminals visible in the destination Session when the scenario ended.
         */
        attachedCount: performanceCountSchema,
        /**
         * Of those, the ones served from a kept-alive pane instead of being rebuilt.
         */
        reusedCount: performanceCountSchema,
        stages: z.strictObject({
            snapshotReplay: terminalStagePerformanceSummarySchema,
            webglAttach: terminalStagePerformanceSummarySchema,
            xtermCreate: terminalStagePerformanceSummarySchema,
        }),
    }),
    longAnimationFrames: longAnimationFrameSummarySchema,
    interactions: interactionPerformanceSummarySchema,
    frames: framePerformanceSummarySchema,
    truncated: z.boolean(),
});

function addAggregateIssue(context: z.core.$RefinementCtx<unknown>, path: string): void {
    context.addIssue({
        code: 'custom',
        message: 'Inconsistent resize burst aggregate',
        path: [path],
    });
}

function addPerformanceAggregateIssue(
    context: z.core.$RefinementCtx<unknown>,
    path: PropertyKey[],
): void {
    context.addIssue({
        code: 'custom',
        message: 'Inconsistent Renderer performance aggregate',
        path,
    });
}

export const rendererDiagnosticSchema = z
    .discriminatedUnion('kind', [
        terminalRendererDiagnosticSchema,
        gpuIncidentBudgetDiagnosticSchema,
        terminalOsc52ClipboardWriteFailureDiagnosticSchema,
        terminalResizeBurstDiagnosticSchema,
        editorWorkerStallDiagnosticSchema,
        rendererPerformanceScenarioDiagnosticSchema,
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

        if (diagnostic.kind !== 'renderer-performance-scenario') return;
        const { react, requests, longAnimationFrames, interactions, frames } = diagnostic;
        if (react.commitCount > react.profiledRenderCount)
            addPerformanceAggregateIssue(context, ['react', 'commitCount']);
        if (
            react.mountRenderCount + react.updateRenderCount + react.nestedUpdateRenderCount !==
            react.profiledRenderCount
        )
            addPerformanceAggregateIssue(context, ['react', 'profiledRenderCount']);
        if (
            react.actualDurationP50Ms > react.actualDurationP95Ms ||
            react.actualDurationP95Ms > react.actualDurationMaxMs
        )
            addPerformanceAggregateIssue(context, ['react', 'actualDurationP95Ms']);
        if (
            react.profiledRenderCount === 0 &&
            [
                react.actualDurationP50Ms,
                react.actualDurationP95Ms,
                react.actualDurationMaxMs,
                react.baseDurationMaxMs,
            ].some((value) => value !== 0)
        )
            addPerformanceAggregateIssue(context, ['react', 'profiledRenderCount']);
        const surfaceSummaries = rendererPerformanceSurfaces.map(
            (surface) => react.surfaces[surface],
        );
        if (
            surfaceSummaries.reduce((total, surface) => total + surface.profiledRenderCount, 0) !==
            react.profiledRenderCount
        )
            addPerformanceAggregateIssue(context, ['react', 'surfaces']);
        if (
            Math.max(0, ...surfaceSummaries.map((surface) => surface.actualDurationMaxMs)) !==
                react.actualDurationMaxMs ||
            Math.max(0, ...surfaceSummaries.map((surface) => surface.baseDurationMaxMs)) !==
                react.baseDurationMaxMs
        )
            addPerformanceAggregateIssue(context, ['react', 'surfaces']);
        for (const surface of rendererPerformanceSurfaces) {
            const summary = react.surfaces[surface];
            if (
                summary.actualDurationP50Ms > summary.actualDurationP95Ms ||
                summary.actualDurationP95Ms > summary.actualDurationMaxMs ||
                summary.actualDurationMaxMs > summary.actualDurationTotalMs
            )
                addPerformanceAggregateIssue(context, [
                    'react',
                    'surfaces',
                    surface,
                    'actualDurationP95Ms',
                ]);
            if (
                summary.profiledRenderCount === 0 &&
                [
                    summary.actualDurationP50Ms,
                    summary.actualDurationP95Ms,
                    summary.actualDurationMaxMs,
                    summary.actualDurationTotalMs,
                    summary.baseDurationMaxMs,
                ].some((value) => value !== 0)
            )
                addPerformanceAggregateIssue(context, [
                    'react',
                    'surfaces',
                    surface,
                    'profiledRenderCount',
                ]);
        }
        if (diagnostic.capabilities.reactProfiler === 'disabled' && react.profiledRenderCount !== 0)
            addPerformanceAggregateIssue(context, ['capabilities', 'reactProfiler']);

        for (const [name, summary] of Object.entries(requests)) {
            if (
                (summary.count === 0 &&
                    (summary.totalDurationMs !== 0 || summary.maxDurationMs !== 0)) ||
                summary.maxDurationMs > summary.totalDurationMs
            )
                addPerformanceAggregateIssue(context, ['requests', name]);
        }

        for (const [name, count, metrics] of [
            [
                'longAnimationFrames',
                longAnimationFrames.count,
                [
                    longAnimationFrames.totalDurationMs,
                    longAnimationFrames.maxDurationMs,
                    longAnimationFrames.totalBlockingDurationMs,
                    longAnimationFrames.maxBlockingDurationMs,
                    longAnimationFrames.maxStyleAndLayoutDurationMs,
                ],
            ],
            [
                'interactions',
                interactions.count,
                [
                    interactions.maxDurationMs,
                    interactions.maxInputDelayMs,
                    interactions.maxProcessingDurationMs,
                    interactions.maxPresentationDelayMs,
                ],
            ],
            [
                'frames',
                frames.sampleCount,
                [
                    frames.estimatedRefreshIntervalMs,
                    frames.intervalP50Ms,
                    frames.intervalP95Ms,
                    frames.maxIntervalMs,
                    frames.missedFrameCount,
                ],
            ],
        ] as const) {
            if (count === 0 && metrics.some((value) => value !== 0))
                addPerformanceAggregateIssue(context, [name, 'count']);
        }

        if (
            diagnostic.capabilities.longAnimationFrame === 'unavailable' &&
            longAnimationFrames.count !== 0
        )
            addPerformanceAggregateIssue(context, ['capabilities', 'longAnimationFrame']);
        if (diagnostic.capabilities.eventTiming === 'unavailable' && interactions.count !== 0)
            addPerformanceAggregateIssue(context, ['capabilities', 'eventTiming']);
        if (
            frames.intervalP50Ms > frames.intervalP95Ms ||
            frames.intervalP95Ms > frames.maxIntervalMs ||
            (frames.sampleCount > 0 && frames.estimatedRefreshIntervalMs === 0)
        )
            addPerformanceAggregateIssue(context, ['frames', 'intervalP95Ms']);
    });

export type TerminalRendererDiagnostic = z.infer<typeof terminalRendererDiagnosticSchema>;
export type GpuIncidentBudgetDiagnostic = z.infer<typeof gpuIncidentBudgetDiagnosticSchema>;
export type TerminalOsc52ClipboardWriteFailureDiagnostic = z.infer<
    typeof terminalOsc52ClipboardWriteFailureDiagnosticSchema
>;
export type TerminalResizeBurstDiagnostic = z.infer<typeof terminalResizeBurstDiagnosticSchema>;
export type EditorWorkerStallDiagnostic = z.infer<typeof editorWorkerStallDiagnosticSchema>;
export type RendererPerformanceScenarioDiagnostic = z.infer<
    typeof rendererPerformanceScenarioDiagnosticSchema
>;
export type RendererDiagnostic = z.infer<typeof rendererDiagnosticSchema>;
