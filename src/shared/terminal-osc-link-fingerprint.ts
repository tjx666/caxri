import { MAX_TERMINAL_LINK_LENGTH, MAX_TERMINAL_LINK_ROWS } from './ipc';

interface TerminalBufferLineReader {
    readonly length: number;
    translateToString(shouldTrimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface TerminalBufferReader {
    getLine(line: number): TerminalBufferLineReader | undefined;
}

export interface TerminalOscLinkPosition {
    column: number;
    line: number;
}

export interface TerminalOscLinkRange {
    end: TerminalOscLinkPosition;
    start: TerminalOscLinkPosition;
}

export function terminalOscLinkCellSpan(
    columns: number,
    start: TerminalOscLinkPosition,
    end: TerminalOscLinkPosition,
): number | undefined {
    if (
        start.line < 0 ||
        end.line < start.line ||
        start.column < 0 ||
        start.column > columns ||
        end.column < 0 ||
        end.column > columns ||
        (end.line === start.line && end.column <= start.column) ||
        end.line - start.line + 1 > MAX_TERMINAL_LINK_ROWS
    )
        return;
    const cellCount =
        end.line === start.line
            ? end.column - start.column
            : columns - start.column + (end.line - start.line - 1) * columns + end.column;
    return cellCount <= MAX_TERMINAL_LINK_LENGTH ? cellCount : undefined;
}

function isTerminalOscLinkPositionBefore(
    left: TerminalOscLinkPosition,
    right: TerminalOscLinkPosition,
): boolean {
    return left.line < right.line || (left.line === right.line && left.column < right.column);
}

export function areTerminalOscLinkRangesOverlapping(
    left: TerminalOscLinkRange,
    right: TerminalOscLinkRange,
): boolean {
    return (
        isTerminalOscLinkPositionBefore(left.start, right.end) &&
        isTerminalOscLinkPositionBefore(right.start, left.end)
    );
}

/**
 * Produces a content-free, bounded fingerprint for public xterm buffer cells. Both Runtime snapshot ownership and
 * Renderer live tracking use this one implementation so overwritten labels fail closed at either process boundary.
 */
export function terminalOscLinkFingerprint(
    columns: number,
    buffer: TerminalBufferReader,
    start: TerminalOscLinkPosition,
    end: TerminalOscLinkPosition,
): string | undefined {
    if (terminalOscLinkCellSpan(columns, start, end) === undefined) return;
    let cellCount = 0;
    let hash = 2_166_136_261;
    for (let lineNumber = start.line; lineNumber <= end.line; lineNumber += 1) {
        const line = buffer.getLine(lineNumber);
        if (!line) return;
        const firstColumn = lineNumber === start.line ? start.column : 0;
        const lastColumn = lineNumber === end.line ? end.column : Math.min(line.length, columns);
        if (lastColumn < firstColumn) return;
        cellCount += lastColumn - firstColumn;
        if (cellCount > MAX_TERMINAL_LINK_LENGTH) return;
        const text = line.translateToString(false, firstColumn, lastColumn);
        for (const character of text) {
            hash ^= character.codePointAt(0) ?? 0;
            hash = Math.imul(hash, 16_777_619);
        }
        hash ^= 10;
        hash = Math.imul(hash, 16_777_619);
    }
    return `${cellCount}:${hash >>> 0}`;
}

export function terminalOscLinkFingerprintCellCount(fingerprint: string): number {
    const separator = fingerprint.indexOf(':');
    return Number(fingerprint.slice(0, separator));
}
