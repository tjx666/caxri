import { notifyListeners } from '@caxri/utils';
import type { PerformanceFrameSnapshot } from '@desktop-shared/performance-monitor';
import { PERFORMANCE_MONITOR_FRAME_CAPACITY } from '@desktop-shared/performance-monitor';

import { computeFrameStats, FrameRing } from './frame-stats';

const BYTES_PER_MEGABYTE = 1024 * 1024;
const COST_SMOOTHING = 0.05;

/**
 * Browser services the collector needs, injected so frame pacing logic is testable without a real display.
 */
export interface CollectorEnvironment {
    cancelFrame(handle: number): void;
    /**
     * `performance.memory`, a Chromium-only extension; `undefined` where it does not exist.
     */
    heap(): { limit: number; used: number } | undefined;
    isVisible(): boolean;
    now(): number;
    /**
     * Calls `listener` with each long animation frame's duration, or returns `undefined` when the entry type is
     * unsupported. The returned function disconnects the observer.
     */
    observeLongFrames(listener: (durationMs: number) => void): (() => void) | undefined;
    onVisibilityChange(listener: () => void): () => void;
    requestFrame(callback: (timestamp: number) => void): number;
}

/**
 * Samples this window's own frame pacing while at least one view wants it. With no subscriber it owns no animation
 * frame request, observer, or listener, so a closed monitor costs the Workbench nothing. The frame callback only writes
 * a number into a preallocated ring; everything derived (rates, bars) is computed when a snapshot is requested.
 *
 * `fps` is the main thread's frame callback rate. Chromium schedules a callback every vsync while one is pending, so an
 * idle page also reads the display refresh rate; this is not the compositor's presented rate, which Electron exposes
 * only through the debugger protocol. Hooks for long frames and Session switches are exposed so other diagnostics can
 * share this observer instead of installing a second one.
 */
export class PerformanceCollector {
    private readonly ring = new FrameRing(PERFORMANCE_MONITOR_FRAME_CAPACITY);
    private subscribers = 0;
    private frameHandle: number | undefined;
    private stopLongFrames: (() => void) | undefined;
    private stopVisibility: (() => void) | undefined;
    private paused = false;
    private longFrameCount = 0;
    private lastLongFrameMs: number | null = null;
    private lastSessionSwitchMs: number | null = null;
    private costUs = 0;
    private readonly longFrameListeners = new Set<(durationMs: number) => void>();
    private readonly sessionSwitchListeners = new Set<(durationMs: number) => void>();

    private readonly onFrame = (timestamp: number): void => {
        const startedAt = this.environment.now();
        this.ring.push(timestamp);
        this.frameHandle = this.environment.requestFrame(this.onFrame);
        const costUs = (this.environment.now() - startedAt) * 1_000;
        this.costUs += (costUs - this.costUs) * COST_SMOOTHING;
    };

    constructor(private readonly environment: CollectorEnvironment) {}

    private start(): void {
        this.paused = !this.environment.isVisible();
        this.ring.reset();
        this.longFrameCount = 0;
        this.lastLongFrameMs = null;
        this.costUs = 0;
        this.stopVisibility = this.environment.onVisibilityChange(() => this.handleVisibility());
        this.stopLongFrames = this.environment.observeLongFrames((durationMs) => {
            this.longFrameCount += 1;
            this.lastLongFrameMs = durationMs;
            notifyListeners(this.longFrameListeners, durationMs);
        });
        this.frameHandle = this.environment.requestFrame(this.onFrame);
    }

    private stop(): void {
        if (this.frameHandle !== undefined) this.environment.cancelFrame(this.frameHandle);
        this.frameHandle = undefined;
        this.stopLongFrames?.();
        this.stopLongFrames = undefined;
        this.stopVisibility?.();
        this.stopVisibility = undefined;
    }

    /**
     * A hidden window gets no frame callbacks; the gap on return would read as one enormous dropped frame, so the ring
     * restarts instead of carrying the gap.
     */
    private handleVisibility(): void {
        this.paused = !this.environment.isVisible();
        this.ring.reset();
    }

    /**
     * Starts sampling on the first subscriber. The returned function releases this subscriber and stops sampling when
     * it was the last one; calling it twice is harmless.
     */
    acquire(): () => void {
        this.subscribers += 1;
        if (this.subscribers === 1) this.start();
        let isReleased = false;
        return () => {
            if (isReleased) return;
            isReleased = true;
            this.subscribers -= 1;
            if (this.subscribers === 0) this.stop();
        };
    }

    isRunning(): boolean {
        return this.subscribers > 0;
    }

    /**
     * Notified of every long animation frame while sampling runs.
     */
    onLongFrame(listener: (durationMs: number) => void): () => void {
        this.longFrameListeners.add(listener);
        return () => this.longFrameListeners.delete(listener);
    }

    onSessionSwitch(listener: (durationMs: number) => void): () => void {
        this.sessionSwitchListeners.add(listener);
        return () => this.sessionSwitchListeners.delete(listener);
    }

    /**
     * Records how long the last Session switch took to settle. Recorded even while no view is open, so the first time
     * the monitor opens it can show the latest switch.
     */
    recordSessionSwitch(durationMs: number): void {
        this.lastSessionSwitchMs = durationMs;
        notifyListeners(this.sessionSwitchListeners, durationMs);
    }

    snapshot(): PerformanceFrameSnapshot {
        const now = this.environment.now();
        const stats = this.paused
            ? { fps: 0, lowFps: 0, minFps: 0 }
            : computeFrameStats(this.ring, now);
        const heap = this.environment.heap();
        return {
            fps: stats.fps,
            minFps: stats.minFps,
            lowFps: stats.lowFps,
            frameMs: this.ring.intervals(),
            longFrameCount: this.longFrameCount,
            lastLongFrameMs: this.lastLongFrameMs,
            jsHeapUsedMb: heap ? heap.used / BYTES_PER_MEGABYTE : null,
            jsHeapLimitMb: heap ? heap.limit / BYTES_PER_MEGABYTE : null,
            lastSessionSwitchMs: this.lastSessionSwitchMs,
            paused: this.paused,
            monitorCostUs: this.costUs,
            capturedAt: Date.now(),
        };
    }
}

function readHeap(): { limit: number; used: number } | undefined {
    const memory: unknown = Reflect.get(performance, 'memory');
    if (typeof memory !== 'object' || memory === null) return undefined;
    const used: unknown = Reflect.get(memory, 'usedJSHeapSize');
    const limit: unknown = Reflect.get(memory, 'jsHeapSizeLimit');
    if (typeof used !== 'number' || typeof limit !== 'number') return undefined;
    return { limit, used };
}

/**
 * Observes `long-animation-frame` entries, which only Chromium 123+ emits.
 */
function observeLongAnimationFrames(
    listener: (durationMs: number) => void,
): (() => void) | undefined {
    if (!PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) return undefined;
    const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) listener(entry.duration);
    });
    observer.observe({ type: 'long-animation-frame', buffered: false });
    return () => observer.disconnect();
}

const browserEnvironment: CollectorEnvironment = {
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    heap: readHeap,
    isVisible: () => document.visibilityState === 'visible',
    now: () => performance.now(),
    observeLongFrames: observeLongAnimationFrames,
    onVisibilityChange: (listener) => {
        document.addEventListener('visibilitychange', listener);
        return () => document.removeEventListener('visibilitychange', listener);
    },
    requestFrame: (callback) => requestAnimationFrame(callback),
};

/**
 * This window's collector. Views acquire it; nothing runs until one does.
 */
export const performanceCollector = new PerformanceCollector(browserEnvironment);

/**
 * Called by Session switching with the time it took to settle; see `features/session/session-commands.ts`.
 */
export function recordSessionSwitchLatency(durationMs: number): void {
    performanceCollector.recordSessionSwitch(durationMs);
}
