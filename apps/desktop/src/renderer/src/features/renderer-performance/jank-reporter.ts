import type {
    LongAnimationFrameInvokerType,
    RendererJankDiagnostic,
    SlowAnimationFrame,
    SlowSessionSwitch,
} from '@caxri/protocol';
import { longAnimationFrameInvokerTypes } from '@caxri/protocol';

/**
 * A Session switch or animation frame must reach this duration to be reported. 100 ms is where a click stops feeling
 * instant, and Chromium only emits a Long Animation Frame from 50 ms, so this keeps ordinary slow frames out of the
 * log.
 */
export const JANK_THRESHOLD_MS = 100;
/**
 * Samples collected before the first flush, and the least time between two flushes. A burst of slow frames is one
 * record, and a Renderer that stays slow for minutes writes at most six records a minute.
 */
const BATCH_WINDOW_MS = 2_000;
const MIN_FLUSH_INTERVAL_MS = 10_000;
const MAX_FRAMES_PER_BATCH = 5;
const MAX_SWITCHES_PER_BATCH = 5;
/**
 * How many recent switch intervals are kept to tell whether a slow frame happened during a switch.
 */
const SWITCH_WINDOW_CAPACITY = 8;

/**
 * One finished Session switch, in `performance.now()` milliseconds.
 */
export interface SessionSwitchTiming {
    /**
     * The Workbench state for the new Session was applied.
     */
    convergedAt: number;
    /**
     * The next frame after convergence was presented.
     */
    paintedAt: number;
    /**
     * The `session.select` reply arrived.
     */
    repliedAt: number;
    /**
     * The select gesture reached the Renderer's command.
     */
    startedAt: number;
}

/**
 * The parts of a `PerformanceScriptTiming` the reporter reads.
 */
interface LongAnimationFrameScript {
    duration: number;
    forcedStyleAndLayoutDuration?: number;
    invokerType?: string;
    sourceFunctionName?: string;
    sourceURL?: string;
}

/**
 * The parts of a `PerformanceLongAnimationFrameTiming` the reporter reads.
 */
export interface LongAnimationFrameEntry {
    blockingDuration?: number;
    duration: number;
    scripts?: readonly LongAnimationFrameScript[];
    startTime: number;
    styleAndLayoutStart?: number;
}

export interface JankReporterDependencies {
    clearTimer(handle: unknown): void;
    isDocumentVisible(): boolean;
    newId(): string;
    now(): number;
    report(diagnostic: RendererJankDiagnostic): void;
    setTimer(callback: () => void, delayMs: number): unknown;
}

interface PendingFrame {
    endedAt: number;
    frame: Omit<SlowAnimationFrame, 'endedAgoMs'>;
    startedAt: number;
}

interface PendingSwitch {
    endedAt: number;
    sample: Omit<SlowSessionSwitch, 'endedAgoMs'>;
}

const invokerTypes: ReadonlySet<string> = new Set(longAnimationFrameInvokerTypes);

function toInvokerType(value: string | undefined): LongAnimationFrameInvokerType {
    return invokerTypes.has(value ?? '') ? (value as LongAnimationFrameInvokerType) : 'unknown';
}

function wholeMs(value: number | undefined): number {
    return Number.isFinite(value) ? Math.min(600_000, Math.max(0, Math.round(value as number))) : 0;
}

/**
 * Keeps the bundle chunk name of a script URL and drops everything else (origin, directories, query). A name that is
 * not a plain identifier-like file name is reported as unknown rather than sanitized, because the contract is that only
 * Caxri's own bundle names cross to the log.
 */
export function bundleFileName(sourceUrl: string | undefined): string | null {
    if (!sourceUrl) return null;
    const withoutQuery = sourceUrl.split(/[?#]/u, 1)[0] ?? '';
    const name = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
    return /^[\w.-]{1,80}$/u.test(name) ? name : null;
}

function functionIdentifier(name: string | undefined): string | null {
    return name && /^[\w$.]{1,64}$/u.test(name) ? name : null;
}

/**
 * Reduces a Long Animation Frame to the fields worth logging, naming the script that spent the most time in it. The
 * attribution is the lead for "which code made this frame long"; the full script list is never sent.
 */
export function toSlowFrame(
    entry: LongAnimationFrameEntry,
    isDuringSessionSwitch: boolean,
): Omit<SlowAnimationFrame, 'endedAgoMs'> {
    const scripts = entry.scripts ?? [];
    let top: LongAnimationFrameScript | undefined;
    for (const script of scripts) if (!top || script.duration > top.duration) top = script;
    // The spec allows 0 for "no style and layout phase"; only a value inside the frame is a real start.
    const styleLayoutMs =
        entry.styleAndLayoutStart !== undefined && entry.styleAndLayoutStart >= entry.startTime
            ? entry.startTime + entry.duration - entry.styleAndLayoutStart
            : 0;
    return {
        durationMs: wholeMs(entry.duration),
        blockingMs: wholeMs(entry.blockingDuration),
        styleLayoutMs: wholeMs(styleLayoutMs),
        isDuringSessionSwitch,
        scriptCount: scripts.length,
        topScript: top
            ? {
                  invokerType: toInvokerType(top.invokerType),
                  durationMs: wholeMs(top.duration),
                  forcedStyleLayoutMs: wholeMs(top.forcedStyleAndLayoutDuration),
                  file: bundleFileName(top.sourceURL),
                  functionName: functionIdentifier(top.sourceFunctionName),
              }
            : null,
    };
}

/**
 * Collects Session switches and Long Animation Frames that crossed {@link JANK_THRESHOLD_MS} and reports them as one
 * rate-limited batch. Samples below the threshold cost a comparison and are dropped, so a healthy Renderer sends
 * nothing. Within a batch only the slowest samples are kept and the rest are counted, which bounds both memory and the
 * size of the record.
 */
export class RendererJankReporter {
    private frames: PendingFrame[] = [];
    private lastFlushAt: number | undefined;
    private omittedFrames = 0;
    private omittedSwitches = 0;
    private switches: PendingSwitch[] = [];
    private recentSwitchWindows: Array<{ end: number; start: number }> = [];
    private timer: unknown;

    constructor(private readonly dependencies: JankReporterDependencies) {}

    private enqueue<T>(
        queue: T[],
        item: T,
        capacity: number,
        weight: (item: T) => number,
        omit: () => void,
    ): void {
        if (queue.length < capacity) queue.push(item);
        else {
            // Keep the slowest: the smallest queued sample is the one displaced, and either way one sample is omitted.
            let smallest = 0;
            for (const [index, candidate] of queue.entries())
                if (weight(candidate) < weight(queue[smallest])) smallest = index;
            if (weight(item) > weight(queue[smallest])) queue[smallest] = item;
            omit();
        }
        this.schedule();
    }

    private schedule(): void {
        if (this.timer !== undefined) return;
        const now = this.dependencies.now();
        const earliest =
            this.lastFlushAt === undefined ? 0 : this.lastFlushAt + MIN_FLUSH_INTERVAL_MS - now;
        this.timer = this.dependencies.setTimer(
            () => this.flush(),
            Math.max(BATCH_WINDOW_MS, earliest),
        );
    }

    /**
     * Records a finished switch. Every switch is remembered briefly for frame attribution; only a slow one is queued.
     */
    recordSessionSwitch(timing: SessionSwitchTiming): void {
        this.recentSwitchWindows.push({ start: timing.startedAt, end: timing.paintedAt });
        if (this.recentSwitchWindows.length > SWITCH_WINDOW_CAPACITY)
            this.recentSwitchWindows.shift();
        const totalMs = timing.paintedAt - timing.startedAt;
        if (totalMs < JANK_THRESHOLD_MS) return;
        this.enqueue(
            this.switches,
            {
                endedAt: timing.paintedAt,
                sample: {
                    totalMs: wholeMs(totalMs),
                    requestMs: wholeMs(timing.repliedAt - timing.startedAt),
                    convergeMs: wholeMs(timing.convergedAt - timing.repliedAt),
                    paintMs: wholeMs(timing.paintedAt - timing.convergedAt),
                },
            },
            MAX_SWITCHES_PER_BATCH,
            (sample) => sample.sample.totalMs,
            () => (this.omittedSwitches += 1),
        );
    }

    /**
     * Records one Long Animation Frame entry when it is long enough and the window is visible.
     */
    recordFrame(entry: LongAnimationFrameEntry): void {
        if (entry.duration < JANK_THRESHOLD_MS || !this.dependencies.isDocumentVisible()) return;
        this.enqueue(
            this.frames,
            {
                endedAt: entry.startTime + entry.duration,
                frame: toSlowFrame(entry, false),
                startedAt: entry.startTime,
            },
            MAX_FRAMES_PER_BATCH,
            (sample) => sample.frame.durationMs,
            () => (this.omittedFrames += 1),
        );
    }

    /**
     * Sends the pending batch when the minimum interval since the last one has passed; otherwise the scheduled timer
     * still sends it. Called when the window hides, so repeated hide and show cycles cannot beat the rate limit.
     */
    flushIfDue(): void {
        const lastFlushAt = this.lastFlushAt;
        if (
            lastFlushAt === undefined ||
            this.dependencies.now() - lastFlushAt >= MIN_FLUSH_INTERVAL_MS
        )
            this.flush();
    }

    /**
     * Sends the pending batch now, if any. Called by the timer.
     */
    flush(): void {
        if (this.timer !== undefined) this.dependencies.clearTimer(this.timer);
        this.timer = undefined;
        if (this.frames.length === 0 && this.switches.length === 0) return;
        const now = this.dependencies.now();
        const endedAgo = (endedAt: number) => wholeMs(now - endedAt);
        const diagnostic: RendererJankDiagnostic = {
            kind: 'renderer-jank',
            diagnosticId: this.dependencies.newId(),
            documentVisible: this.dependencies.isDocumentVisible(),
            // A frame is delivered before the switch that contains it finishes, so overlap is decided here, once the
            // switch windows are known.
            frames: this.frames.map(({ endedAt, frame, startedAt }) => ({
                ...frame,
                isDuringSessionSwitch: this.recentSwitchWindows.some(
                    (window) => startedAt <= window.end && endedAt >= window.start,
                ),
                endedAgoMs: endedAgo(endedAt),
            })),
            omittedFrameCount: this.omittedFrames,
            switches: this.switches.map(({ endedAt, sample }) => ({
                ...sample,
                endedAgoMs: endedAgo(endedAt),
            })),
            omittedSwitchCount: this.omittedSwitches,
        };
        this.frames = [];
        this.switches = [];
        this.omittedFrames = 0;
        this.omittedSwitches = 0;
        this.lastFlushAt = now;
        this.dependencies.report(diagnostic);
    }
}
