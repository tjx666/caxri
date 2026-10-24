import type {
    AppLocale,
    PerformanceMonitorMetrics,
    RendererErrorKind,
    ThemeTokens,
} from '@caxri/protocol';
import { z } from 'zod';

/**
 * Frames kept for the bar graph, newest last. One bar per frame at 240 entries covers about four seconds at 60 Hz.
 */
export const PERFORMANCE_MONITOR_FRAME_CAPACITY = 240;

const finiteNumber = z.number();

/**
 * One reading of the monitored Workbench's frame pacing, taken in that window's Renderer. Every field is bounded
 * because the same payload crosses Main to the monitor window and is validated on the way.
 */
export const performanceFrameSnapshotSchema = z.object({
    /**
     * Frame callbacks per second over the last second, from `requestAnimationFrame` timestamps. This is the main
     * thread's frame callback rate, not the compositor's presented rate; see `docs/performance-monitor.md`.
     */
    fps: finiteNumber.min(0).max(2_000),
    /**
     * The slowest frame's rate in the window.
     */
    minFps: finiteNumber.min(0).max(2_000),
    /**
     * The rate implied by the slowest 1% of frames (the "1% low").
     */
    lowFps: finiteNumber.min(0).max(2_000),
    /**
     * Recent frame intervals in milliseconds, oldest first, for the bar graph.
     */
    frameMs: z.array(finiteNumber.min(0).max(60_000)).max(PERFORMANCE_MONITOR_FRAME_CAPACITY),
    longFrameCount: z.number().int().nonnegative().max(1_000_000),
    lastLongFrameMs: finiteNumber.min(0).max(600_000).nullable(),
    jsHeapUsedMb: finiteNumber.min(0).max(1_000_000).nullable(),
    jsHeapLimitMb: finiteNumber.min(0).max(1_000_000).nullable(),
    /**
     * The last Session switch's reply latency, or `null` before the first.
     */
    lastSessionSwitchMs: finiteNumber.min(0).max(600_000).nullable(),
    /**
     * True while the window is hidden or minimized, when `requestAnimationFrame` stops by design.
     */
    paused: z.boolean(),
    /**
     * Average cost in microseconds of the monitor's own frame callback.
     */
    monitorCostUs: finiteNumber.min(0).max(1_000_000),
    capturedAt: finiteNumber,
});
export type PerformanceFrameSnapshot = z.infer<typeof performanceFrameSnapshotSchema>;

/**
 * One Workbench load as Main observed it. Stage values are milliseconds after the navigation started (`t0`), so they
 * are cumulative; a stage that has not happened (or never will, on failure) is absent.
 */
export interface ReloadEntry {
    id: number;
    kind: 'reload' | 'hard-reload';
    startedAt: number;
    /**
     * `loading` is in flight.
     */
    outcome: 'loading' | 'done' | 'failed';
    stages: Partial<Record<ReloadStageName, number>>;
    /**
     * Why the load failed, as a closed set; absent unless `outcome` is `failed`.
     */
    failure?: 'did-fail-load' | 'render-process-gone' | 'unresponsive';
}

export type ReloadStageName = 'domReady' | 'didFinishLoad' | 'loaderRemoved' | 'firstFrame';

export interface PerformanceMonitorState {
    /**
     * Whether a Workbench window is available to monitor, and whether it is visible on screen.
     */
    target: 'visible' | 'hidden' | 'loading' | 'missing';
    alwaysOnTop: boolean;
    /**
     * Newest first; Main keeps the last ten.
     */
    reloads: ReloadEntry[];
}

export type PerformanceMonitorControl =
    { type: 'start' } | { type: 'stop' } | { type: 'show-overlay' };

/**
 * The Workbench side of the monitor, installed by the Workbench preload. It exists so a detached monitor can read frame
 * pacing without any debugger attach: the Renderer measures itself and Main only relays.
 */
export interface PerformanceMonitorHostBridge {
    /**
     * Asks Main whether a detached monitor is open for this window, so a freshly reloaded Renderer resumes publishing
     * even though it missed the `start` control that fired before its scripts loaded.
     */
    isActive(): Promise<boolean>;
    onControl(listener: (control: PerformanceMonitorControl) => void): () => void;
    publish(snapshot: PerformanceFrameSnapshot): void;
}

/**
 * Narrow bridge exposed only to the Performance Monitor window's Renderer.
 */
export interface PerformanceMonitorWindowBridge {
    /**
     * Reports only a fault class; private exception values never cross the preload boundary.
     */
    reportError(kind: RendererErrorKind): void;
    getState(): Promise<PerformanceMonitorState>;
    metrics(): Promise<PerformanceMonitorMetrics>;
    /**
     * Reloads the monitored Workbench from Main, so the timeline's start is Main's own clock.
     */
    reload(options: { ignoreCache: boolean }): Promise<void>;
    switchToOverlay(): Promise<void>;
    setAlwaysOnTop(isOnTop: boolean): Promise<void>;
    theme(): Promise<ThemeTokens>;
    language(): Promise<AppLocale | null>;
    onLanguageChanged(listener: (preference: AppLocale | null) => void): () => void;
    onSnapshot(listener: (snapshot: PerformanceFrameSnapshot) => void): () => void;
    onState(listener: (state: PerformanceMonitorState) => void): () => void;
}
