export interface TerminalSize {
    cols: number;
    rows: number;
}

type CancelFrame = (frame: number) => void;
type RequestFrame = (callback: () => void) => number;

const DEFAULT_SETTLE_FRAME_BUDGET = 8;

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
 * Keeps the final text cell clear of xterm's overlaid vertical scrollbar. The fit addon reserves only the scrollbar's
 * exact width, so fractional cell rounding can otherwise leave a zero-pixel gutter and make the last glyph look clipped
 * while the thumb is visible.
 */
export function terminalSizeWithScrollbarGutter(
    proposed: TerminalSize | undefined,
): TerminalSize | undefined {
    if (!proposed) return undefined;
    return { cols: Math.max(2, proposed.cols - 1), rows: proposed.rows };
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
