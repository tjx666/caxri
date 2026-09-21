import type { RendererPerformanceScenarioDiagnostic } from '@caxri/protocol';
import { rendererPerformanceSurfaces } from '@caxri/protocol';

export type RendererPerformanceAction = RendererPerformanceScenarioDiagnostic['action'];
export type RendererPerformanceBuildMode = RendererPerformanceScenarioDiagnostic['buildMode'];
export type RendererPerformanceSurface =
    keyof RendererPerformanceScenarioDiagnostic['react']['surfaces'];

export interface ReactProfileSample {
    actualDurationMs: number;
    baseDurationMs: number;
    commitTime: number;
    phase: 'mount' | 'nested-update' | 'update';
    surface: RendererPerformanceSurface;
}

export interface LongAnimationFrameSample {
    blockingDurationMs: number;
    durationMs: number;
    styleAndLayoutDurationMs: number;
}

export interface InteractionPerformanceSample {
    durationMs: number;
    inputDelayMs: number;
    presentationDelayMs: number;
    processingDurationMs: number;
}

export type RendererPerformanceRequest = 'app.bootstrap' | 'session.select';

export interface RequestPerformanceSample {
    durationMs: number;
    request: RendererPerformanceRequest;
}

/**
 * The three separable costs of putting a Terminal on screen. Keeping them apart is what makes the Session keep-alive
 * measurable: a warm switch should report zero samples in every stage.
 */
export type TerminalPerformanceStage = 'snapshot-replay' | 'webgl-attach' | 'xterm-create';

export interface TerminalStagePerformanceSample {
    durationMs: number;
    stage: TerminalPerformanceStage;
}

export interface RendererPerformanceSamples {
    action: RendererPerformanceAction;
    buildMode: RendererPerformanceBuildMode;
    capabilities: RendererPerformanceScenarioDiagnostic['capabilities'];
    diagnosticId: string;
    documentFocused: boolean;
    documentVisible: boolean;
    endedAt: number;
    focusInterrupted: boolean;
    frameTimestamps: readonly number[];
    interactions: readonly InteractionPerformanceSample[];
    longAnimationFrames: readonly LongAnimationFrameSample[];
    reactProfiles: readonly ReactProfileSample[];
    requests: readonly RequestPerformanceSample[];
    scenarioId: string;
    startedAt: number;
    terminalAttachedCount: number;
    terminalReusedCount: number;
    terminalStages: readonly TerminalStagePerformanceSample[];
    truncated: boolean;
    visibilityInterrupted: boolean;
}

const maximumDurationMs = 120_000;
const maximumCount = 1_000_000;
const maximumFrameSamples = 20_000;

function boundedDuration(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.round(Math.min(maximumDurationMs, Math.max(0, value)) * 100) / 100;
}

function boundedCount(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(maximumCount, Math.max(0, Math.trunc(value)));
}

function sum(values: readonly number[]): number {
    return boundedDuration(values.reduce((total, value) => total + boundedDuration(value), 0));
}

function maximum(values: readonly number[]): number {
    return boundedDuration(values.length === 0 ? 0 : Math.max(...values));
}

function percentile(values: readonly number[], quantile: number): number {
    if (values.length === 0) return 0;
    const sorted = values.map(boundedDuration).toSorted((left, right) => left - right);
    const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
    return sorted[index] ?? 0;
}

function summarizeReactSurface(
    samples: readonly ReactProfileSample[],
): RendererPerformanceScenarioDiagnostic['react']['surfaces'][RendererPerformanceSurface] {
    const actualDurations = samples.map((sample) => sample.actualDurationMs);
    return {
        profiledRenderCount: boundedCount(samples.length),
        actualDurationP50Ms: percentile(actualDurations, 0.5),
        actualDurationP95Ms: percentile(actualDurations, 0.95),
        actualDurationMaxMs: maximum(actualDurations),
        actualDurationTotalMs: sum(actualDurations),
        baseDurationMaxMs: maximum(samples.map((sample) => sample.baseDurationMs)),
    };
}

function summarizeReact(
    samples: readonly ReactProfileSample[],
): RendererPerformanceScenarioDiagnostic['react'] {
    const actualDurations = samples.map((sample) => sample.actualDurationMs);
    const surfaceSamples = Object.fromEntries(
        rendererPerformanceSurfaces.map((surface) => [
            surface,
            samples.filter((sample) => sample.surface === surface),
        ]),
    ) as Record<RendererPerformanceSurface, ReactProfileSample[]>;

    return {
        commitCount: boundedCount(new Set(samples.map((sample) => sample.commitTime)).size),
        profiledRenderCount: boundedCount(samples.length),
        mountRenderCount: boundedCount(samples.filter((sample) => sample.phase === 'mount').length),
        updateRenderCount: boundedCount(
            samples.filter((sample) => sample.phase === 'update').length,
        ),
        nestedUpdateRenderCount: boundedCount(
            samples.filter((sample) => sample.phase === 'nested-update').length,
        ),
        actualDurationP50Ms: percentile(actualDurations, 0.5),
        actualDurationP95Ms: percentile(actualDurations, 0.95),
        actualDurationMaxMs: maximum(actualDurations),
        baseDurationMaxMs: maximum(samples.map((sample) => sample.baseDurationMs)),
        surfaces: {
            'primary-sidebar': summarizeReactSurface(surfaceSamples['primary-sidebar']),
            'workbench': summarizeReactSurface(surfaceSamples.workbench),
            'secondary-sidebar': summarizeReactSurface(surfaceSamples['secondary-sidebar']),
        },
    };
}

function summarizeRequests(
    samples: readonly RequestPerformanceSample[],
): RendererPerformanceScenarioDiagnostic['requests'] {
    const summaries: Record<
        RendererPerformanceRequest,
        RendererPerformanceScenarioDiagnostic['requests']['sessionSelect']
    > = {
        'session.select': { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
        'app.bootstrap': { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
    };

    for (const sample of samples) {
        const summary = summaries[sample.request];
        const durationMs = boundedDuration(sample.durationMs);
        summary.count = boundedCount(summary.count + 1);
        summary.totalDurationMs = boundedDuration(summary.totalDurationMs + durationMs);
        summary.maxDurationMs = boundedDuration(Math.max(summary.maxDurationMs, durationMs));
    }

    return {
        sessionSelect: summaries['session.select'],
        appBootstrap: summaries['app.bootstrap'],
    };
}

function summarizeTerminals(
    samples: RendererPerformanceSamples,
): RendererPerformanceScenarioDiagnostic['terminals'] {
    const stages: RendererPerformanceScenarioDiagnostic['terminals']['stages'] = {
        snapshotReplay: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
        webglAttach: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
        xtermCreate: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
    };
    const byStage: Record<TerminalPerformanceStage, keyof typeof stages> = {
        'snapshot-replay': 'snapshotReplay',
        'webgl-attach': 'webglAttach',
        'xterm-create': 'xtermCreate',
    };

    for (const sample of samples.terminalStages) {
        const summary = stages[byStage[sample.stage]];
        const durationMs = boundedDuration(sample.durationMs);
        summary.count = boundedCount(summary.count + 1);
        summary.totalDurationMs = boundedDuration(summary.totalDurationMs + durationMs);
        summary.maxDurationMs = boundedDuration(Math.max(summary.maxDurationMs, durationMs));
    }

    return {
        attachedCount: boundedCount(samples.terminalAttachedCount),
        reusedCount: boundedCount(samples.terminalReusedCount),
        stages,
    };
}

function summarizeFrames(
    timestamps: readonly number[],
): RendererPerformanceScenarioDiagnostic['frames'] {
    const intervals: number[] = [];
    for (
        let index = 1;
        index < timestamps.length && intervals.length < maximumFrameSamples;
        index += 1
    ) {
        const interval = timestamps[index] - timestamps[index - 1];
        if (Number.isFinite(interval) && interval > 0) intervals.push(interval);
    }
    if (intervals.length === 0) {
        return {
            sampleCount: 0,
            estimatedRefreshIntervalMs: 0,
            intervalP50Ms: 0,
            intervalP95Ms: 0,
            maxIntervalMs: 0,
            missedFrameCount: 0,
        };
    }

    const refreshInterval = percentile(intervals, 0.2);
    const missedFrameCount = intervals.reduce(
        (count, interval) => count + Math.max(0, Math.round(interval / refreshInterval) - 1),
        0,
    );
    return {
        sampleCount: intervals.length,
        estimatedRefreshIntervalMs: refreshInterval,
        intervalP50Ms: percentile(intervals, 0.5),
        intervalP95Ms: percentile(intervals, 0.95),
        maxIntervalMs: maximum(intervals),
        missedFrameCount: boundedCount(missedFrameCount),
    };
}

export function summarizeRendererPerformance(
    samples: RendererPerformanceSamples,
): RendererPerformanceScenarioDiagnostic {
    const longAnimationFrames = samples.longAnimationFrames;
    const interactions = samples.interactions;
    return {
        kind: 'renderer-performance-scenario',
        diagnosticId: samples.diagnosticId,
        scenarioId: samples.scenarioId,
        entry: 'workbench',
        action: samples.action,
        buildMode: samples.buildMode,
        durationMs: boundedDuration(samples.endedAt - samples.startedAt),
        documentVisible: samples.documentVisible,
        documentFocused: samples.documentFocused,
        visibilityInterrupted: samples.visibilityInterrupted,
        focusInterrupted: samples.focusInterrupted,
        capabilities: samples.capabilities,
        react: summarizeReact(samples.reactProfiles),
        requests: summarizeRequests(samples.requests),
        terminals: summarizeTerminals(samples),
        longAnimationFrames: {
            count: boundedCount(longAnimationFrames.length),
            totalDurationMs: sum(longAnimationFrames.map((sample) => sample.durationMs)),
            maxDurationMs: maximum(longAnimationFrames.map((sample) => sample.durationMs)),
            totalBlockingDurationMs: sum(
                longAnimationFrames.map((sample) => sample.blockingDurationMs),
            ),
            maxBlockingDurationMs: maximum(
                longAnimationFrames.map((sample) => sample.blockingDurationMs),
            ),
            maxStyleAndLayoutDurationMs: maximum(
                longAnimationFrames.map((sample) => sample.styleAndLayoutDurationMs),
            ),
        },
        interactions: {
            count: boundedCount(interactions.length),
            maxDurationMs: maximum(interactions.map((sample) => sample.durationMs)),
            maxInputDelayMs: maximum(interactions.map((sample) => sample.inputDelayMs)),
            maxProcessingDurationMs: maximum(
                interactions.map((sample) => sample.processingDurationMs),
            ),
            maxPresentationDelayMs: maximum(
                interactions.map((sample) => sample.presentationDelayMs),
            ),
        },
        frames: summarizeFrames(samples.frameTimestamps),
        truncated: samples.truncated || samples.frameTimestamps.length - 1 > maximumFrameSamples,
    };
}
