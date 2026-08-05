export interface TerminalSize {
    cols: number;
    rows: number;
}

/** ResizeObserver can repeat unchanged layouts; only a new PTY grid size needs Runtime IPC. */
export function terminalSizeChanged(
    previous: TerminalSize | undefined,
    next: TerminalSize,
): boolean {
    return previous?.cols !== next.cols || previous.rows !== next.rows;
}
