import type { ProfilerOnRenderCallback } from 'react';

import type { RendererPerformanceScenarioDiagnostic } from '@caxri/protocol';
import { rendererPerformanceActions } from '@caxri/protocol';

import type {
    InteractionPerformanceSample,
    LongAnimationFrameSample,
    ReactProfileSample,
    RendererPerformanceAction,
    RendererPerformanceBuildMode,
    RendererPerformanceRequest,
    RendererPerformanceSamples,
    RendererPerformanceSurface,
    RequestPerformanceSample,
    TerminalPerformanceStage,
    TerminalStagePerformanceSample,
} from './aggregation';
import { summarizeRendererPerformance } from './aggregation';

const maximumScenarioDurationMs = 120_000;
const maximumReactProfileSamples = 10_000;
const maximumLongAnimationFrameSamples = 2_000;
const maximumInteractionSamples = 2_000;
const maximumFrameTimestamps = 20_001;
const maximumRequestSamples = 100;
const maximumTerminalStageSamples = 1_000;
const supportedActions: ReadonlySet<string> = new Set(rendererPerformanceActions);

interface LongAnimationFrameEntry extends PerformanceEntry {
    blockingDuration?: number;
    renderStart?: number;
    styleAndLayoutStart?: number;
}

interface EventTimingEntry extends PerformanceEntry {
    interactionId?: number;
    processingEnd?: number;
    processingStart?: number;
}

interface RendererPerformanceGlobal {
    caxriE2E?: unknown;
    caxriPerformance?: RendererPerformanceMonitor;
}

interface ActiveScenario extends RendererPerformanceSamples {
    animationFrameId: number;
    frameTimestamps: number[];
    interactionById: Map<number, InteractionPerformanceSample>;
    interactions: InteractionPerformanceSample[];
    longAnimationFrames: LongAnimationFrameSample[];
    observers: PerformanceObserver[];
    reactProfiles: ReactProfileSample[];
    requests: RequestPerformanceSample[];
    pendingRequestCount: number;
    terminalAttachedCount: number;
    terminalReusedCount: number;
    terminalStages: TerminalStagePerformanceSample[];
    timeoutId: number;
}

interface RendererPerformanceStatus {
    action: RendererPerformanceAction | null;
    capabilities: RendererPerformanceScenarioDiagnostic['capabilities'];
    frameSampleCount: number;
    pendingRequestCount: number;
    scenarioId: string | null;
}

interface RendererPerformanceMonitor {
    begin(action: RendererPerformanceAction): string;
    end(scenarioId: string): RendererPerformanceScenarioDiagnostic;
    status(): RendererPerformanceStatus;
}

function isBrowserEntryTypeSupported(type: string): boolean {
    return (
        typeof PerformanceObserver !== 'undefined' &&
        PerformanceObserver.supportedEntryTypes.includes(type)
    );
}

function resolveBuildMode(): RendererPerformanceBuildMode {
    if (__CAXRI_REACT_PROFILING__) return 'profiling';
    return import.meta.env.DEV ? 'development' : 'production';
}

function isReactProfilerAvailable(): boolean {
    return import.meta.env.DEV || __CAXRI_REACT_PROFILING__;
}

function createScenario(action: RendererPerformanceAction): ActiveScenario {
    const startedAt = performance.now();
    return {
        diagnosticId: crypto.randomUUID(),
        scenarioId: crypto.randomUUID(),
        action,
        buildMode: resolveBuildMode(),
        startedAt,
        endedAt: startedAt,
        documentVisible: document.visibilityState === 'visible',
        documentFocused: document.hasFocus(),
        visibilityInterrupted: false,
        focusInterrupted: false,
        capabilities: {
            longAnimationFrame: isBrowserEntryTypeSupported('long-animation-frame')
                ? 'available'
                : 'unavailable',
            eventTiming: isBrowserEntryTypeSupported('event') ? 'available' : 'unavailable',
            reactProfiler: isReactProfilerAvailable() ? 'available' : 'disabled',
        },
        reactProfiles: [],
        requests: [],
        pendingRequestCount: 0,
        terminalAttachedCount: 0,
        terminalReusedCount: 0,
        terminalStages: [],
        longAnimationFrames: [],
        interactions: [],
        interactionById: new Map(),
        frameTimestamps: [],
        truncated: false,
        observers: [],
        animationFrameId: 0,
        timeoutId: 0,
    };
}

function pushBounded<T>(values: T[], value: T, maximum: number, scenario: ActiveScenario): void {
    if (values.length >= maximum) {
        scenario.truncated = true;
        return;
    }
    values.push(value);
}

function consumeLongAnimationFrames(
    scenario: ActiveScenario,
    entries: readonly PerformanceEntry[],
): void {
    for (const rawEntry of entries) {
        const entry = rawEntry as LongAnimationFrameEntry;
        const styleAndLayoutDurationMs =
            entry.styleAndLayoutStart && entry.styleAndLayoutStart > entry.startTime
                ? Math.max(0, entry.startTime + entry.duration - entry.styleAndLayoutStart)
                : 0;
        pushBounded<LongAnimationFrameSample>(
            scenario.longAnimationFrames,
            {
                durationMs: entry.duration,
                blockingDurationMs: entry.blockingDuration ?? 0,
                styleAndLayoutDurationMs,
            },
            maximumLongAnimationFrameSamples,
            scenario,
        );
    }
}

function consumeEventTiming(scenario: ActiveScenario, entries: readonly PerformanceEntry[]): void {
    for (const rawEntry of entries) {
        const entry = rawEntry as EventTimingEntry;
        const interactionId = entry.interactionId ?? 0;
        if (interactionId === 0) continue;
        const processingStart = entry.processingStart ?? entry.startTime;
        const processingEnd = entry.processingEnd ?? processingStart;
        const sample = {
            durationMs: entry.duration,
            inputDelayMs: Math.max(0, processingStart - entry.startTime),
            processingDurationMs: Math.max(0, processingEnd - processingStart),
            presentationDelayMs: Math.max(0, entry.startTime + entry.duration - processingEnd),
        };
        const previous = scenario.interactionById.get(interactionId);
        scenario.interactionById.set(interactionId, {
            durationMs: Math.max(previous?.durationMs ?? 0, sample.durationMs),
            inputDelayMs: Math.max(previous?.inputDelayMs ?? 0, sample.inputDelayMs),
            processingDurationMs: Math.max(
                previous?.processingDurationMs ?? 0,
                sample.processingDurationMs,
            ),
            presentationDelayMs: Math.max(
                previous?.presentationDelayMs ?? 0,
                sample.presentationDelayMs,
            ),
        });
        if (scenario.interactionById.size > maximumInteractionSamples) {
            scenario.interactionById.delete(interactionId);
            scenario.truncated = true;
        }
    }
}

function startObserver(
    scenario: ActiveScenario,
    type: 'event' | 'long-animation-frame',
    consume: (scenario: ActiveScenario, entries: readonly PerformanceEntry[]) => void,
): void {
    if (!isBrowserEntryTypeSupported(type)) return;
    const observer = new PerformanceObserver((list) => consume(scenario, list.getEntries()));
    try {
        observer.observe(
            type === 'event'
                ? ({ type, buffered: false, durationThreshold: 16 } as PerformanceObserverInit)
                : { type, buffered: false },
        );
        scenario.observers.push(observer);
    } catch {
        scenario.capabilities[type === 'event' ? 'eventTiming' : 'longAnimationFrame'] =
            'unavailable';
        observer.disconnect();
    }
}

class RendererPerformanceController implements RendererPerformanceMonitor {
    private activeScenario?: ActiveScenario;

    private readonly sampleFrame = (timestamp: number): void => {
        const scenario = this.activeScenario;
        if (!scenario) return;
        pushBounded(scenario.frameTimestamps, timestamp, maximumFrameTimestamps, scenario);
        scenario.animationFrameId = requestAnimationFrame(this.sampleFrame);
    };

    private readonly handleVisibilityChange = (): void => {
        if (this.activeScenario && document.visibilityState !== 'visible')
            this.activeScenario.visibilityInterrupted = true;
    };

    private readonly handleWindowBlur = (): void => {
        if (this.activeScenario) this.activeScenario.focusInterrupted = true;
    };

    begin(action: RendererPerformanceAction): string {
        if (!supportedActions.has(action))
            throw new Error('Unsupported Renderer performance action');
        if (this.activeScenario)
            throw new Error('A Renderer performance scenario is already active');
        const scenario = createScenario(action);
        this.activeScenario = scenario;
        startObserver(scenario, 'long-animation-frame', consumeLongAnimationFrames);
        startObserver(scenario, 'event', consumeEventTiming);
        scenario.animationFrameId = requestAnimationFrame(this.sampleFrame);
        scenario.timeoutId = setTimeout(
            () => this.end(scenario.scenarioId),
            maximumScenarioDurationMs,
        );
        return scenario.scenarioId;
    }

    end(scenarioId: string): RendererPerformanceScenarioDiagnostic {
        const scenario = this.activeScenario;
        if (!scenario || scenario.scenarioId !== scenarioId)
            throw new Error('Renderer performance scenario is not active');

        this.activeScenario = undefined;
        cancelAnimationFrame(scenario.animationFrameId);
        clearTimeout(scenario.timeoutId);
        for (const observer of scenario.observers) {
            const entries = observer.takeRecords();
            const type = entries[0]?.entryType;
            if (type === 'long-animation-frame') consumeLongAnimationFrames(scenario, entries);
            else if (type === 'event') consumeEventTiming(scenario, entries);
            observer.disconnect();
        }
        scenario.interactions = scenario.interactionById.values().toArray();
        if (scenario.pendingRequestCount > 0) scenario.truncated = true;
        scenario.endedAt = performance.now();
        const diagnostic = summarizeRendererPerformance(scenario);
        globalThis.caxri.reportDiagnostic(diagnostic);
        return diagnostic;
    }

    status(): RendererPerformanceStatus {
        return {
            scenarioId: this.activeScenario?.scenarioId ?? null,
            action: this.activeScenario?.action ?? null,
            frameSampleCount: this.activeScenario?.frameTimestamps.length ?? 0,
            pendingRequestCount: this.activeScenario?.pendingRequestCount ?? 0,
            capabilities: this.activeScenario?.capabilities ?? {
                longAnimationFrame: isBrowserEntryTypeSupported('long-animation-frame')
                    ? 'available'
                    : 'unavailable',
                eventTiming: isBrowserEntryTypeSupported('event') ? 'available' : 'unavailable',
                reactProfiler: isReactProfilerAvailable() ? 'available' : 'disabled',
            },
        };
    }

    recordReactProfile(
        surface: RendererPerformanceSurface,
        phase: Parameters<ProfilerOnRenderCallback>[1],
        actualDurationMs: number,
        baseDurationMs: number,
        commitTime: number,
    ): void {
        const scenario = this.activeScenario;
        if (scenario?.capabilities.reactProfiler !== 'available') return;
        pushBounded<ReactProfileSample>(
            scenario.reactProfiles,
            { surface, phase, actualDurationMs, baseDurationMs, commitTime },
            maximumReactProfileSamples,
            scenario,
        );
    }

    /**
     * Brackets one Terminal mount stage. Unlike a request it may run dozens of times per scenario: once per Terminal
     * per stage, so it is not counted as pending work: a scenario must be allowed to settle while a kept-alive pane is
     * still finishing a stage nobody is waiting on.
     */
    beginTerminalStage(stage: TerminalPerformanceStage): () => void {
        const scenario = this.activeScenario;
        if (!scenario) return () => {};
        const scenarioId = scenario.scenarioId;
        const startedAt = performance.now();
        let isSettled = false;
        return () => {
            if (isSettled) return;
            isSettled = true;
            const activeScenario = this.activeScenario;
            if (!activeScenario || activeScenario.scenarioId !== scenarioId) return;
            pushBounded(
                activeScenario.terminalStages,
                { stage, durationMs: performance.now() - startedAt },
                maximumTerminalStageSamples,
                activeScenario,
            );
        };
    }

    recordTerminalAttachment(isReused: boolean): void {
        const scenario = this.activeScenario;
        if (!scenario) return;
        scenario.terminalAttachedCount += 1;
        if (isReused) scenario.terminalReusedCount += 1;
    }

    beginRequest(request: RendererPerformanceRequest): () => void {
        const scenario = this.activeScenario;
        if (!scenario) return () => {};
        const scenarioId = scenario.scenarioId;
        const startedAt = performance.now();
        scenario.pendingRequestCount += 1;
        let isSettled = false;
        return () => {
            if (isSettled) return;
            isSettled = true;
            const activeScenario = this.activeScenario;
            if (!activeScenario || activeScenario.scenarioId !== scenarioId) return;
            activeScenario.pendingRequestCount = Math.max(
                0,
                activeScenario.pendingRequestCount - 1,
            );
            pushBounded(
                activeScenario.requests,
                { request, durationMs: performance.now() - startedAt },
                maximumRequestSamples,
                activeScenario,
            );
        };
    }

    install(): void {
        const performanceGlobal = globalThis as RendererPerformanceGlobal;
        const shouldExpose =
            import.meta.env.DEV ||
            __CAXRI_REACT_PROFILING__ ||
            performanceGlobal.caxriE2E !== undefined;
        if (!shouldExpose || performanceGlobal.caxriPerformance) return;
        performanceGlobal.caxriPerformance = this;
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
        addEventListener('blur', this.handleWindowBlur);
    }
}

const controller = new RendererPerformanceController();

export function recordReactProfile(
    surface: RendererPerformanceSurface,
    phase: Parameters<ProfilerOnRenderCallback>[1],
    actualDurationMs: number,
    baseDurationMs: number,
    commitTime: number,
): void {
    controller.recordReactProfile(surface, phase, actualDurationMs, baseDurationMs, commitTime);
}

/**
 * Brackets the two fixed Server requests that determine Session-switch readiness. The returned callback is idempotent
 * so every success and failure path can settle the same in-memory sample without adding a general request logger.
 */
export function beginRendererPerformanceRequest(request: RendererPerformanceRequest): () => void {
    return controller.beginRequest(request);
}

/**
 * Brackets one Terminal mount stage so a Session switch can be read as "what did it rebuild", not just "how long did it
 * take". Returns a no-op when no scenario is running, so the call sites stay unconditional.
 */
export function beginRendererPerformanceTerminalStage(stage: TerminalPerformanceStage): () => void {
    return controller.beginTerminalStage(stage);
}

/**
 * Records that one Terminal became visible, and whether it was served from a kept-alive pane instead of being rebuilt.
 */
export function recordRendererPerformanceTerminalAttachment(isReused: boolean): void {
    controller.recordTerminalAttachment(isReused);
}

/**
 * Exposes a small scenario API only to development, profiling, and E2E builds. Production still contains the inert
 * Profiler boundaries so the profiling alias can be enabled without changing the component tree.
 */
export function installRendererPerformanceMonitoring(): void {
    controller.install();
}
