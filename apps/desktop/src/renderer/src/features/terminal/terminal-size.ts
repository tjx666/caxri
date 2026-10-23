import { GridBurstAccumulator } from '@caxri/utils';

export interface TerminalSize {
    cols: number;
    rows: number;
}

type CancelFrame = (frame: number) => void;
type RequestFrame = (callback: () => void) => number;
type TimerHandle = ReturnType<typeof setTimeout>;
type ClearTimer = (timer: TimerHandle) => void;
type SetTimer = (callback: () => void, delayMs: number) => TimerHandle;

const DEFAULT_SETTLE_FRAME_BUDGET = 8;
const DEFAULT_RESIZE_BURST_QUIET_MS = 250;
const DEFAULT_RESIZE_BURST_MAX_DURATION_MS = 5_000;
const DEFAULT_RESIZE_BURST_MAX_SAMPLES = 10_000;

export type TerminalResizeBurstFlushReason = 'disposed' | 'max-duration' | 'paused' | 'quiet';

export interface TerminalResizeBurstSummary {
    /**
     * Grid transitions relative to the grid in force before the burst; `0` means the burst re-sampled the existing grid
     * and never changed it.
     */
    changeCount: number;
    durationMs: number;
    finalCols: number;
    finalRows: number;
    flushReason: TerminalResizeBurstFlushReason;
    localAppliedCount: number;
    maxCols: number;
    maxRows: number;
    minCols: number;
    minRows: number;
    requestCount: number;
    sampleCount: number;
    startCols: number;
    startRows: number;
    truncated: boolean;
}

interface TerminalResizeBurstSample {
    localApplied: boolean;
    requestSent: boolean;
}

interface TerminalResizeBurstTrackerOptions {
    clearTimer?: ClearTimer;
    emit: (summary: TerminalResizeBurstSummary) => void;
    maxDurationMs?: number;
    maxSamples?: number;
    now?: () => number;
    quietMs?: number;
    setTimer?: SetTimer;
}

function positiveInteger(value: number, name: string, maximum?: number): number {
    if (!Number.isSafeInteger(value) || value <= 0 || (maximum !== undefined && value > maximum))
        throw new RangeError(`${name} must be a positive bounded integer`);
    return value;
}

function isValidTerminalSize(size: TerminalSize): boolean {
    return (
        Number.isSafeInteger(size.cols) &&
        size.cols >= 2 &&
        size.cols <= 1_000 &&
        Number.isSafeInteger(size.rows) &&
        size.rows >= 1 &&
        size.rows <= 1_000
    );
}

/**
 * Coalesces one mounted xterm's high-frequency fit observations into content-free bounded diagnostics.
 */
export class TerminalResizeBurstTracker {
    private readonly accumulator = new GridBurstAccumulator();
    private readonly clearTimer: ClearTimer;
    private readonly emit: (summary: TerminalResizeBurstSummary) => void;
    private readonly maxDurationMs: number;
    private readonly maxSamples: number;
    private readonly now: () => number;
    private readonly quietMs: number;
    private readonly setTimer: SetTimer;
    private burstSeeded = false;
    private burstStartedAt: number | undefined;
    private disposed = false;
    private lastGrid: TerminalSize | undefined;
    private lastSampleAt: number | undefined;
    private localAppliedCount = 0;
    private maxDurationTimer: TimerHandle | undefined;
    private paused = false;
    private quietTimer: TimerHandle | undefined;
    private requestCount = 0;

    constructor(options: TerminalResizeBurstTrackerOptions) {
        this.emit = options.emit;
        this.now = options.now ?? (() => Date.now());
        this.quietMs = positiveInteger(
            options.quietMs ?? DEFAULT_RESIZE_BURST_QUIET_MS,
            'Resize burst quiet window',
            DEFAULT_RESIZE_BURST_MAX_DURATION_MS,
        );
        this.maxDurationMs = positiveInteger(
            options.maxDurationMs ?? DEFAULT_RESIZE_BURST_MAX_DURATION_MS,
            'Resize burst maximum duration',
            DEFAULT_RESIZE_BURST_MAX_DURATION_MS,
        );
        this.maxSamples = positiveInteger(
            options.maxSamples ?? DEFAULT_RESIZE_BURST_MAX_SAMPLES,
            'Resize burst maximum samples',
            DEFAULT_RESIZE_BURST_MAX_SAMPLES,
        );
        this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
        this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    }

    private cancelTimers(): void {
        if (this.quietTimer !== undefined) this.clearTimer(this.quietTimer);
        if (this.maxDurationTimer !== undefined) this.clearTimer(this.maxDurationTimer);
        this.quietTimer = undefined;
        this.maxDurationTimer = undefined;
    }

    private flush(flushReason: TerminalResizeBurstFlushReason): void {
        this.cancelTimers();
        const aggregate = this.accumulator.reset();
        const burstStartedAt = this.burstStartedAt;
        const lastSampleAt = this.lastSampleAt;
        const localAppliedCount = this.localAppliedCount;
        const requestCount = this.requestCount;
        const burstSeeded = this.burstSeeded;
        this.burstStartedAt = undefined;
        this.lastSampleAt = undefined;
        this.localAppliedCount = 0;
        this.requestCount = 0;
        this.burstSeeded = false;
        if (
            !aggregate ||
            burstStartedAt === undefined ||
            lastSampleAt === undefined ||
            (localAppliedCount === 0 && requestCount === 0) ||
            /**
             * One fit that left the grid where it was (every pane mount and Session switch) is not a burst, and was
             * nearly all of this report's volume. Terminal Host already records the grid it applies.
             */
            (aggregate.sampleCount <= 1 && aggregate.changeCount === 0)
        )
            return;

        const rawDurationMs = Math.max(0, lastSampleAt - burstStartedAt);
        const sampleCount = Math.min(aggregate.sampleCount, this.maxSamples);
        // A seeded burst compares every real sample against the pre-burst grid too, so up to `sampleCount`
        // transitions are possible; an unseeded burst's first sample has nothing to compare against, so the bound
        // stays `sampleCount - 1`.
        const maxChangeCount = burstSeeded ? sampleCount : Math.max(0, sampleCount - 1);
        const report: TerminalResizeBurstSummary = {
            sampleCount,
            changeCount: Math.min(aggregate.changeCount, maxChangeCount),
            startCols: aggregate.start.cols,
            startRows: aggregate.start.rows,
            minCols: aggregate.minimum.cols,
            minRows: aggregate.minimum.rows,
            maxCols: aggregate.maximum.cols,
            maxRows: aggregate.maximum.rows,
            finalCols: aggregate.final.cols,
            finalRows: aggregate.final.rows,
            durationMs: Math.min(rawDurationMs, this.maxDurationMs),
            flushReason,
            truncated:
                aggregate.sampleCount > this.maxSamples || rawDurationMs > this.maxDurationMs,
            localAppliedCount: Math.min(localAppliedCount, sampleCount),
            requestCount: Math.min(requestCount, sampleCount),
        };
        try {
            this.emit(report);
        } catch {
            // Diagnostics are best-effort and must never disturb Terminal layout or snapshot recovery.
        }
    }

    sample(size: TerminalSize, observation: TerminalResizeBurstSample): void {
        if (this.disposed || this.paused || !isValidTerminalSize(size)) return;
        const sampledAt = this.now();
        if (this.burstStartedAt === undefined) {
            this.burstStartedAt = sampledAt;
            if (this.lastGrid !== undefined) {
                this.accumulator.seed(this.lastGrid);
                this.burstSeeded = true;
            }
            this.maxDurationTimer = this.setTimer(
                () => this.flush('max-duration'),
                this.maxDurationMs,
            );
        }
        this.lastSampleAt = sampledAt;
        this.accumulator.sample(size);
        this.lastGrid = { cols: size.cols, rows: size.rows };
        if (observation.localApplied) this.localAppliedCount += 1;
        if (observation.requestSent) this.requestCount += 1;
        if (this.quietTimer !== undefined) this.clearTimer(this.quietTimer);
        this.quietTimer = this.setTimer(() => this.flush('quiet'), this.quietMs);
    }

    pause(): void {
        if (this.disposed || this.paused) return;
        this.paused = true;
        this.flush('paused');
    }

    resume(): void {
        if (!this.disposed) this.paused = false;
    }

    dispose(): void {
        if (this.disposed) return;
        this.flush('disposed');
        this.disposed = true;
        this.paused = true;
    }
}

interface TerminalPaneResizeControllerOptions {
    apply(size: TerminalSize): void;
    current(): TerminalSize;
    fitted(size: TerminalSize): void;
    isRunning(): boolean;
    propose(): TerminalSize | undefined;
    request(size: TerminalSize): Promise<unknown>;
    terminalId: string;
}

interface TerminalFitResult {
    localApplied: boolean;
    displayedSize: TerminalSize;
    requestedSize: TerminalSize;
}

/**
 * Owns one pane's fit, local xterm resize, Server resize deduplication, and resize-burst reporting so React lifecycle
 * wiring cannot accidentally observe a proposal at only one of those boundaries.
 */
export class TerminalPaneResizeController {
    private lastSentSize: TerminalSize | undefined;
    private mobileSize: TerminalSize | undefined;
    private readonly tracker: TerminalResizeBurstTracker;

    constructor(private readonly options: TerminalPaneResizeControllerOptions) {
        this.tracker = new TerminalResizeBurstTracker({
            emit: (summary) =>
                globalThis.caxri.reportDiagnostic({
                    kind: 'terminal-resize-burst',
                    diagnosticId: crypto.randomUUID(),
                    terminalId: options.terminalId,
                    side: 'renderer-xterm',
                    ...summary,
                }),
        });
    }

    /**
     * The proposal is used exactly as the fit addon computed it. The addon already subtracts `scrollbar.width`, which
     * `use-terminal-pane-runtime` sets to the 8px the stylesheet actually paints, so the grid ends where the slider
     * begins. Reserving anything beyond that (Caxri previously dropped one whole text column here) widens the right
     * inset to two gutters and, because the reservation has to stay constant while the PTY runs, buys nothing: the
     * column count cannot follow the slider appearing or disappearing without re-wrapping every line mid-session. VS
     * Code reserves the same single scrollbar width (`TerminalScrollbarWidth` in `xtermTerminal.ts`), and a reservation
     * that disagrees with the painted width is what makes mouse selection drift on the right edge.
     */
    private fit(): TerminalFitResult | undefined {
        try {
            const requestedSize = this.options.propose();
            if (!requestedSize) return undefined;
            const displayedSize = this.mobileSize ?? requestedSize;
            const isLocalApplied = didTerminalSizeChange(this.options.current(), displayedSize);
            if (isLocalApplied) this.options.apply(displayedSize);
            this.options.fitted(displayedSize);
            return { localApplied: isLocalApplied, displayedSize, requestedSize };
        } catch {
            // The pane may be between layout and disposal during a Session switch.
            return undefined;
        }
    }

    private async request(size: TerminalSize): Promise<void> {
        try {
            await this.options.request(size);
        } catch {
            /**
             * Server restarts can reject a resize; allow the next layout observation to retry it.
             */
            if (this.lastSentSize?.cols === size.cols && this.lastSentSize.rows === size.rows)
                this.lastSentSize = undefined;
        }
    }

    fitAndResize(): void {
        const result = this.fit();
        if (!result) return;
        const requestSent =
            this.options.isRunning() &&
            didTerminalSizeChange(this.lastSentSize, result.requestedSize);
        this.tracker.sample(result.displayedSize, {
            localApplied: result.localApplied,
            requestSent,
        });
        if (!requestSent) return;
        this.lastSentSize = result.requestedSize;
        void this.request(result.requestedSize);
    }

    fitInitial(): TerminalSize | undefined {
        const result = this.fit();
        if (!result) return undefined;
        this.tracker.sample(result.displayedSize, {
            localApplied: result.localApplied,
            requestSent: true,
        });
        return result.requestedSize;
    }

    /**
     * A mobile lease changes the PTY grid while Desktop still owns its desired post-lease size. Keep xterm aligned with
     * the PTY and continue reporting container fits to the Host for release.
     */
    setSizeOwnership(owner: 'desktop' | 'mobile', size: TerminalSize): void {
        this.mobileSize = owner === 'mobile' ? size : undefined;
        const isLocalApplied = didTerminalSizeChange(this.options.current(), size);
        if (isLocalApplied) this.options.apply(size);
        this.options.fitted(size);
        this.tracker.sample(size, { localApplied: isLocalApplied, requestSent: false });
        if (owner === 'desktop') this.fitAndResize();
    }

    resetSizeOwnership(): void {
        this.mobileSize = undefined;
        this.fit();
    }

    confirmSent(size: TerminalSize): void {
        this.lastSentSize = size;
    }

    pause(): void {
        this.tracker.pause();
    }

    resume(): void {
        this.tracker.resume();
    }

    dispose(): void {
        this.tracker.dispose();
    }
}

/**
 * Keeps one bounded trailing fit loop alive after a layout observation. Split-pane layout can expose an intermediate
 * narrow container and then reach its final width without another reliable ResizeObserver callback; sampling once per
 * frame catches that final grid while downstream size deduplication prevents redundant PTY IPC.
 */
export class TerminalResizeSettler {
    private frame: number | undefined;
    private paused = false;
    private remainingFrames = 0;

    constructor(
        private readonly onFrame: () => void,
        private readonly requestFrame: RequestFrame = (callback) => requestAnimationFrame(callback),
        private readonly cancelFrame: CancelFrame = (frame) => cancelAnimationFrame(frame),
        private readonly frameBudget = DEFAULT_SETTLE_FRAME_BUDGET,
    ) {}

    private flush(): void {
        this.frame = undefined;
        if (this.remainingFrames === 0) return;
        this.remainingFrames -= 1;
        this.onFrame();
        if (this.remainingFrames > 0) this.requestNext();
    }

    private requestNext(): void {
        this.frame = this.requestFrame(() => this.flush());
    }

    schedule(): void {
        if (this.paused) return;
        this.remainingFrames = this.frameBudget;
        if (this.frame === undefined) this.requestNext();
    }

    /**
     * Keeps layout-driven fitting out of snapshot replay, where xterm must retain the recorded source grid.
     */
    pause(): void {
        this.paused = true;
        this.remainingFrames = 0;
        if (this.frame !== undefined) this.cancelFrame(this.frame);
        this.frame = undefined;
    }

    resume(): void {
        if (!this.paused) return;
        this.paused = false;
        this.schedule();
    }

    dispose(): void {
        this.pause();
    }
}

/**
 * ResizeObserver can repeat unchanged layouts; only a new PTY grid size needs Server IPC.
 */
export function didTerminalSizeChange(
    previous: TerminalSize | undefined,
    next: TerminalSize,
): boolean {
    return previous?.cols !== next.cols || previous.rows !== next.rows;
}
