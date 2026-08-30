import type { RendererPerformanceScenarioDiagnostic } from '@caxri/protocol';

export type RendererPerformanceAction = RendererPerformanceScenarioDiagnostic['action'];
export type RendererPerformanceBuildMode = RendererPerformanceScenarioDiagnostic['buildMode'];
export type RendererPerformanceSurface = NonNullable<
    RendererPerformanceScenarioDiagnostic['react']['slowestSurface']
>;

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

export interface ReactScanCommitSample {
    commitId: number;
    componentName: string | null;
    renderCount: number;
    totalDurationMs: number;
    treeTruncated: boolean;
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
    reactScanCommits: readonly ReactScanCommitSample[];
    scenarioId: string;
    startedAt: number;
    truncated: boolean;
    visibilityInterrupted: boolean;
}

const maximumDurationMs = 120_000;
const maximumCount = 1_000_000;
const maximumFrameSamples = 20_000;
const safeComponentName = /^[\w $().:#[\]-]+$/u;

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

function summarizeReact(
    samples: readonly ReactProfileSample[],
): RendererPerformanceScenarioDiagnostic['react'] {
    const surfaceDurations = new Map<RendererPerformanceSurface, number>();
    for (const sample of samples) {
        surfaceDurations.set(
            sample.surface,
            (surfaceDurations.get(sample.surface) ?? 0) + boundedDuration(sample.actualDurationMs),
        );
    }
    const slowestSurfaceEntry = [...surfaceDurations]
        .toSorted((left, right) => right[1] - left[1])
        .at(0);
    const slowestSurface = slowestSurfaceEntry
        ? { name: slowestSurfaceEntry[0], durationMs: slowestSurfaceEntry[1] }
        : { name: null, durationMs: 0 };
    const actualDurations = samples.map((sample) => sample.actualDurationMs);

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
        slowestSurface: slowestSurface.name,
        slowestSurfaceDurationMs: boundedDuration(slowestSurface.durationMs),
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

function summarizeReactScan(samples: readonly ReactScanCommitSample[]): {
    summary: RendererPerformanceScenarioDiagnostic['reactScan'];
    discardedUnsafeName: boolean;
} {
    const componentAggregates = new Map<string, { renderCount: number; totalDurationMs: number }>();
    let isDiscardedUnsafeName = false;
    for (const sample of samples) {
        const componentName = sample.componentName;
        const isSafeName =
            componentName !== null &&
            componentName.length <= 120 &&
            safeComponentName.test(componentName);
        const name =
            isSafeName && componentName !== 'Anonymous' && /^[A-Z]/u.test(componentName)
                ? componentName
                : null;
        if (!name) {
            isDiscardedUnsafeName ||= componentName !== null && !isSafeName;
            continue;
        }
        const aggregate = componentAggregates.get(name) ?? { renderCount: 0, totalDurationMs: 0 };
        aggregate.renderCount += boundedCount(sample.renderCount);
        aggregate.totalDurationMs += boundedDuration(sample.totalDurationMs);
        componentAggregates.set(name, aggregate);
    }
    const slowest = [...componentAggregates]
        .toSorted((left, right) => right[1].totalDurationMs - left[1].totalDurationMs)
        .at(0);
    const renderCount = boundedCount(
        samples.reduce((total, sample) => total + boundedCount(sample.renderCount), 0),
    );
    const slowestComponent = slowest
        ? {
              name: slowest[0],
              renderCount: slowest[1].renderCount,
              totalDurationMs: slowest[1].totalDurationMs,
          }
        : { name: renderCount > 0 ? 'Unknown' : null, renderCount, totalDurationMs: 0 };

    return {
        summary: {
            commitCount: boundedCount(new Set(samples.map((sample) => sample.commitId)).size),
            renderCount,
            slowestComponent: slowestComponent.name,
            slowestComponentRenderCount: boundedCount(slowestComponent.renderCount),
            slowestComponentTotalDurationMs: boundedDuration(slowestComponent.totalDurationMs),
            treeTruncated: samples.some((sample) => sample.treeTruncated),
        },
        discardedUnsafeName: isDiscardedUnsafeName,
    };
}

export function summarizeRendererPerformance(
    samples: RendererPerformanceSamples,
): RendererPerformanceScenarioDiagnostic {
    const reactScan = summarizeReactScan(samples.reactScanCommits);
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
        reactScan: reactScan.summary,
        truncated:
            samples.truncated ||
            reactScan.discardedUnsafeName ||
            samples.frameTimestamps.length - 1 > maximumFrameSamples,
    };
}
