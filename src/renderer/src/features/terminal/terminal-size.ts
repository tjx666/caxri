export interface TerminalSize {
    cols: number;
    rows: number;
}

/**
 * Keeps the final text cell clear of xterm's overlaid vertical scrollbar. The fit addon reserves
 * only the scrollbar's exact width, so fractional cell rounding can otherwise leave a zero-pixel
 * gutter and make the last glyph look clipped while the thumb is visible.
 */
export function terminalSizeWithScrollbarGutter(
    proposed: TerminalSize | undefined,
): TerminalSize | undefined {
    if (!proposed) return undefined;
    return { cols: Math.max(2, proposed.cols - 1), rows: proposed.rows };
}

/**
ResizeObserver can repeat unchanged layouts; only a new PTY grid size needs Runtime IPC.
 */
export function didTerminalSizeChange(
    previous: TerminalSize | undefined,
    next: TerminalSize,
): boolean {
    return previous?.cols !== next.cols || previous.rows !== next.rows;
}
