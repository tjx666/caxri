import { MAX_TERMINAL_LINK_LENGTH, MAX_TERMINAL_LINK_ROWS } from './terminal-limits.js';

interface TerminalBufferLineReader {
    getCell(column: number): { getChars(): string; getWidth(): number } | undefined;
    readonly isWrapped: boolean;
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

export interface TerminalOscLinkLogicalPosition {
    cellOffset: number;
    logicalLineIndex: number;
    logicalLineOffset: number;
}

export interface TerminalOscLinkCellAnchor {
    cellOffset: number;
    line: number;
}

export interface TerminalOscLinkRange {
    end: TerminalOscLinkPosition;
    start: TerminalOscLinkPosition;
}

function terminalLogicalLineStart(
    buffer: TerminalBufferReader & { readonly length: number },
    line: number,
    minimumLine: number,
): number | undefined {
    if (
        minimumLine < 0 ||
        minimumLine >= buffer.length ||
        line < minimumLine ||
        line >= buffer.length
    )
        return;
    let logicalLineStart = line;
    while (logicalLineStart > minimumLine) {
        const currentLine = buffer.getLine(logicalLineStart);
        if (!currentLine?.isWrapped) break;
        logicalLineStart -= 1;
    }
    return logicalLineStart;
}

function resolveTerminalOscLinkPositionFromLogicalLineStart(
    buffer: TerminalBufferReader & { readonly length: number },
    columns: number,
    logicalLineStart: number,
    cellOffset: number,
): TerminalOscLinkPosition | undefined {
    if (columns < 1 || cellOffset < 0 || !Number.isSafeInteger(cellOffset)) return;
    let logicalLineEnd = buffer.length;
    for (let lineNumber = logicalLineStart + 1; lineNumber < buffer.length; lineNumber += 1) {
        const line = buffer.getLine(lineNumber);
        if (!line) return;
        if (!line.isWrapped) {
            logicalLineEnd = lineNumber;
            break;
        }
    }
    const relativeLine = Math.floor(cellOffset / columns);
    const column = cellOffset % columns;
    const line = logicalLineStart + relativeLine;
    if (line < logicalLineEnd) return { column, line };
    if (column === 0 && line === logicalLineEnd && line > logicalLineStart)
        return { column: columns, line: line - 1 };
    return;
}

/**
 * Captures both a reflow-stable logical-line offset and the physical first row that can safely own its xterm marker.
 */
export function terminalOscLinkCellAnchor(
    buffer: TerminalBufferReader & { readonly length: number },
    columns: number,
    position: TerminalOscLinkPosition,
): TerminalOscLinkCellAnchor | undefined {
    if (columns < 1 || position.column < 0 || position.column > columns) return;
    const logicalLineStart = terminalLogicalLineStart(buffer, position.line, 0);
    if (logicalLineStart === undefined) return;
    return {
        cellOffset: (position.line - logicalLineStart) * columns + position.column,
        line: logicalLineStart,
    };
}

/**
 * Re-resolves a stable logical-line cell offset after xterm moves its anchor marker during reflow.
 */
export function resolveTerminalOscLinkCellOffset(
    buffer: TerminalBufferReader & { readonly length: number },
    columns: number,
    anchorLine: number,
    cellOffset: number,
): TerminalOscLinkPosition | undefined {
    const logicalLineStart = terminalLogicalLineStart(buffer, anchorLine, 0);
    if (logicalLineStart === undefined) return;
    return resolveTerminalOscLinkPositionFromLogicalLineStart(
        buffer,
        columns,
        logicalLineStart,
        cellOffset,
    );
}

/**
 * Encodes a physical xterm position relative to both ends of its logical wrapped-line sequence. The dual logical line
 * anchors and cell offset survive inactive-buffer reflow, trailing viewport-row changes, and bounded scrollback trims;
 * a physical row or cursor offset cannot. `minimumLine` treats a bounded SerializeAddon tail as the first logical
 * line.
 */
export function terminalOscLinkLogicalPosition(
    buffer: TerminalBufferReader & { readonly length: number },
    columns: number,
    position: TerminalOscLinkPosition,
    minimumLine = 0,
): TerminalOscLinkLogicalPosition | undefined {
    if (
        columns < 1 ||
        minimumLine < 0 ||
        minimumLine >= buffer.length ||
        position.line < minimumLine ||
        position.line >= buffer.length ||
        position.column < 0 ||
        position.column > columns
    )
        return;
    const logicalLineStart = terminalLogicalLineStart(buffer, position.line, minimumLine);
    if (logicalLineStart === undefined) return;
    let logicalLineIndex = 0;
    for (let lineNumber = minimumLine + 1; lineNumber <= logicalLineStart; lineNumber += 1) {
        const line = buffer.getLine(lineNumber);
        if (!line) return;
        if (!line.isWrapped) logicalLineIndex += 1;
    }
    let logicalLineOffset = -1;
    for (let lineNumber = logicalLineStart + 1; lineNumber < buffer.length; lineNumber += 1) {
        const line = buffer.getLine(lineNumber);
        if (!line) return;
        if (!line.isWrapped) logicalLineOffset -= 1;
    }
    return {
        cellOffset: (position.line - logicalLineStart) * columns + position.column,
        logicalLineIndex,
        logicalLineOffset,
    };
}

/**
 * Resolves a reflow-stable logical position against the buffer's current physical row layout.
 */
export function resolveTerminalOscLinkLogicalPosition(
    buffer: TerminalBufferReader & { readonly length: number },
    columns: number,
    position: TerminalOscLinkLogicalPosition,
    anchor: 'start' | 'end',
): TerminalOscLinkPosition | undefined {
    if (
        columns < 1 ||
        position.cellOffset < 0 ||
        !Number.isSafeInteger(position.cellOffset) ||
        position.logicalLineIndex < 0 ||
        !Number.isSafeInteger(position.logicalLineIndex) ||
        position.logicalLineOffset > -1 ||
        !Number.isSafeInteger(position.logicalLineOffset)
    )
        return;
    let logicalLineStart: number | undefined;
    if (anchor === 'start') {
        let logicalLineIndex = 0;
        for (let lineNumber = 0; lineNumber < buffer.length; lineNumber += 1) {
            const line = buffer.getLine(lineNumber);
            if (!line) return;
            if (lineNumber > 0 && line.isWrapped) continue;
            if (logicalLineIndex === position.logicalLineIndex) {
                logicalLineStart = lineNumber;
                break;
            }
            logicalLineIndex += 1;
        }
    } else {
        let remainingLogicalLines = -position.logicalLineOffset;
        for (let lineNumber = buffer.length - 1; lineNumber >= 0; lineNumber -= 1) {
            const line = buffer.getLine(lineNumber);
            if (!line) return;
            if (lineNumber > 0 && line.isWrapped) continue;
            remainingLogicalLines -= 1;
            if (remainingLogicalLines === 0) {
                logicalLineStart = lineNumber;
                break;
            }
        }
    }
    if (logicalLineStart === undefined) return;
    return resolveTerminalOscLinkPositionFromLogicalLineStart(
        buffer,
        columns,
        logicalLineStart,
        position.cellOffset,
    );
}

function terminalOscLinkCellSpan(
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
        end.line - start.line + (end.column === 0 && end.line > start.line ? 0 : 1) >
            MAX_TERMINAL_LINK_ROWS
    )
        return;
    const cellCount =
        end.line === start.line
            ? end.column - start.column
            : columns - start.column + (end.line - start.line - 1) * columns + end.column;
    return cellCount <= MAX_TERMINAL_LINK_LENGTH ? cellCount : undefined;
}

function populatedLineEnd(
    line: TerminalBufferLineReader,
    firstColumn: number,
    columns: number,
): number {
    for (let column = Math.min(line.length, columns) - 1; column >= firstColumn; column -= 1) {
        const cell = line.getCell(column);
        if (!cell?.getChars()) continue;
        return Math.min(columns, column + Math.max(1, cell.getWidth()));
    }
    return firstColumn;
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
        let isHardLineBreak = false;
        let lastColumn: number;
        if (lineNumber === end.line) lastColumn = end.column;
        else {
            const nextLine = buffer.getLine(lineNumber + 1);
            if (!nextLine) return;
            isHardLineBreak = !nextLine.isWrapped;
            lastColumn = isHardLineBreak
                ? populatedLineEnd(line, firstColumn, columns)
                : Math.min(line.length, columns);
        }
        if (lastColumn < firstColumn) return;
        cellCount += lastColumn - firstColumn;
        if (isHardLineBreak) cellCount += 1;
        if (cellCount > MAX_TERMINAL_LINK_LENGTH) return;
        const text = line.translateToString(false, firstColumn, lastColumn);
        for (const character of text) {
            hash ^= character.codePointAt(0) ?? 0;
            hash = Math.imul(hash, 16_777_619);
        }
        if (isHardLineBreak) {
            hash ^= 10;
            hash = Math.imul(hash, 16_777_619);
        }
    }
    return `${cellCount}:${hash >>> 0}`;
}

export function terminalOscLinkFingerprintCellCount(fingerprint: string): number {
    const separator = fingerprint.indexOf(':');
    return Number(fingerprint.slice(0, separator));
}
