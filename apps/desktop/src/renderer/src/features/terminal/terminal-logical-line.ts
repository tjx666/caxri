import type { IBufferCellPosition, IBufferLine, Terminal } from '@xterm/xterm';

import {
    MAX_TERMINAL_LINK_LENGTH as MAX_LOGICAL_LINE_LENGTH,
    MAX_TERMINAL_LINK_ROWS as MAX_LOGICAL_LINE_ROWS,
} from './terminal-osc-link-tracker';

export interface TerminalLogicalLine {
    firstBufferLine: number;
    lastBufferLine: number;
    positions: IBufferCellPosition[];
    text: string;
}

/**
 * Rebuilds one bounded xterm soft-wrapped line and maps UTF-16 offsets back to buffer cells. Upstream programs may also
 * emit explicit physical newlines; the link layer analyzes those separately so ordinary line breaks stay independent.
 */
export function readSoftWrappedLogicalLine(
    terminal: Terminal,
    bufferLineNumber: number,
): TerminalLogicalLine | undefined {
    const buffer = terminal.buffer.active;
    const requested = bufferLineNumber - 1;
    if (requested < 0 || requested >= buffer.length) return;
    let first = requested;
    let rowCount = 1;
    while (first > 0 && buffer.getLine(first)?.isWrapped && rowCount < MAX_LOGICAL_LINE_ROWS) {
        first -= 1;
        rowCount += 1;
    }
    let last = requested;
    while (
        last + 1 < buffer.length &&
        buffer.getLine(last + 1)?.isWrapped &&
        last - first + 1 < MAX_LOGICAL_LINE_ROWS
    )
        last += 1;

    let text = '';
    const positions: IBufferCellPosition[] = [];
    for (let y = first; y <= last && text.length < MAX_LOGICAL_LINE_LENGTH; y += 1) {
        const line = buffer.getLine(y);
        if (!line) break;
        const lineText = line.translateToString(true);
        appendLineCellPositions(line, y, lineText, terminal.cols, positions);
        text += lineText.slice(0, Math.min(lineText.length, MAX_LOGICAL_LINE_LENGTH - text.length));
    }
    return { firstBufferLine: first, lastBufferLine: last, positions, text };
}

/**
 * Concatenates two adjacent line groups while dropping only the syntactically verified continuation indent. Keeping the
 * first and last cells produces the one contiguous xterm range used from either physical row.
 */
export function joinTerminalLogicalLines(
    first: TerminalLogicalLine,
    continuation: TerminalLogicalLine,
    continuationOffset: number,
): TerminalLogicalLine {
    return {
        firstBufferLine: first.firstBufferLine,
        lastBufferLine: continuation.lastBufferLine,
        positions: [...first.positions, ...continuation.positions.slice(continuationOffset)],
        text: first.text + continuation.text.slice(continuationOffset),
    };
}

/**
 * Maps one logical-text position per UTF-16 code unit, skipping zero-width cells (the trailing half of a wide glyph).
 */
function appendLineCellPositions(
    line: IBufferLine,
    y: number,
    lineText: string,
    columns: number,
    positions: IBufferCellPosition[],
): void {
    let offset = 0;
    for (let x = 0; x < Math.min(line.length, columns) && offset < lineText.length; x += 1) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || ' ';
        for (let index = 0; index < chars.length && offset < lineText.length; index += 1) {
            positions.push({ x: x + 1, y: y + 1 });
            offset += 1;
        }
    }
}
