interface SnapshotTerminal {
    resize(cols: number, rows: number): void;
    write(data: string): void;
}

/**
 * Queue RIS with parser input so old asynchronous writes finish before the screen is cleared. A synchronous reset
 * leaves xterm's pending write buffer intact, which can replay over the new snapshot.
 * https://github.com/xtermjs/xterm.js/blob/master/src/common/CoreTerminal.ts
 */
export const resetTerminalSnapshot = (
    terminal: SnapshotTerminal,
    cols: number,
    rows: number,
): void => {
    terminal.resize(cols, rows);
    terminal.write('\u{1B}c');
};
