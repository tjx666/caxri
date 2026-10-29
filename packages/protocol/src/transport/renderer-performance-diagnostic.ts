import { z } from 'zod';

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

/**
 * Bracketed Renderer actions: `session.switch` covers one Session switch, `agentChat.stream` a window in which an Agent
 * Chat receives a streamed reply or tool updates with no user interaction.
 */
export const rendererPerformanceActions = ['session.switch', 'agentChat.stream'] as const;

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

export type RendererPerformanceScenarioDiagnostic = z.infer<
    typeof rendererPerformanceScenarioDiagnosticSchema
>;

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

/**
 * Cross-field consistency of one scenario receipt: the strict schema bounds each value, and this rejects receipts whose
 * aggregates cannot describe the same run.
 */
export function refineRendererPerformanceScenario(
    diagnostic: RendererPerformanceScenarioDiagnostic,
    context: z.core.$RefinementCtx<unknown>,
): void {
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
    const surfaceSummaries = rendererPerformanceSurfaces.map((surface) => react.surfaces[surface]);
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
}
