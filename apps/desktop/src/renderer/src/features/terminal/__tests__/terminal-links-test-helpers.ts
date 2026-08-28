import type { IBuffer, ILink, ILinkProvider, IMarker, Terminal } from '@xterm/xterm';
import { vi } from 'vitest';

/**
 * Return type of {@link createTerminal}, spelled out explicitly because TypeScript cannot name the inferred type of a
 * `vi.fn()`-bearing object literal without a reference into `@vitest/spy`'s internal `Procedure` type (TS2883).
 */
export interface FakeTerminal {
    dispose: ReturnType<typeof vi.fn>;
    disposeMarkersAtLine(line: number): void;
    links(bufferLineNumber?: number): Promise<ILink[] | undefined>;
    osc8(data: string): boolean | undefined;
    reflowNormal(lines: readonly string[], columns: number): void;
    setActiveBuffer(type: 'alternate' | 'normal'): void;
    setAlternateLine(line: number, value: string): void;
    setCursor(line: number, column: number): void;
    setLine(line: number, value: string, isWrapped?: boolean): void;
    setSize(columns: number, rows: number): void;
    setViewport(line: number): void;
    terminal: Terminal;
}

/**
 * Minimal fake xterm `Terminal` shared by `terminal-links.test.ts` and `terminal-link-scanner.test.ts`: enough of the
 * public buffer/marker/link-provider surface to drive `registerTerminalLinks` and `createTerminalLinkScanner` without a
 * real DOM or WebGL renderer.
 */
export function createTerminal(
    text: string,
    cells: Array<{ chars: string; width: number }>,
): FakeTerminal {
    let provider: ILinkProvider | undefined;
    let osc8Handler: ((data: string) => boolean | Promise<boolean>) | undefined;
    let markerId = 0;
    let cursorColumn = text.length;
    let cursorLine = 0;
    let terminalColumns = 120;
    let terminalRows = 1;
    let viewportLine = 0;
    const lineCells = [cells];
    const lineWrapped = [false];
    const alternateLineCells = [cellsFor('ALTERNATE')];
    const bufferChangeCallbacks: Array<(buffer: IBuffer) => void> = [];
    const markers: IMarker[] = [];
    const dispose = vi.fn();
    const createBufferLine = (
        currentCells: Array<{ chars: string; width: number }>,
        isWrapped: boolean,
    ) => ({
        getCell: (column: number) => {
            // `.at()` (rather than `[column]`) keeps an out-of-range index's `undefined` case in the type, since this
            // project does not enable `noUncheckedIndexedAccess`.
            const cell = currentCells.at(column);
            return cell ? { getChars: () => cell.chars, getWidth: () => cell.width } : undefined;
        },
        isWrapped,
        length: currentCells.length,
        translateToString: (
            shouldTrimRight = false,
            startColumn = 0,
            endColumn = currentCells.length,
        ) => {
            const value = currentCells
                .slice(startColumn, endColumn)
                .map(({ chars }) => chars)
                .join('');
            return shouldTrimRight ? value.trimEnd() : value;
        },
    });
    const createBuffer = (
        type: 'alternate' | 'normal',
        currentLines: Array<Array<{ chars: string; width: number }>>,
    ) => ({
        baseY: 0,
        get cursorX() {
            return cursorColumn;
        },
        get cursorY() {
            return cursorLine;
        },
        getLine: (line: number) => {
            const currentCells = currentLines.at(line);
            return currentCells
                ? createBufferLine(
                      currentCells,
                      type === 'normal' && (lineWrapped.at(line) ?? false),
                  )
                : undefined;
        },
        get length() {
            return currentLines.length;
        },
        type,
        get viewportY() {
            return viewportLine;
        },
    });
    const normalBuffer = createBuffer('normal', lineCells);
    const alternateBuffer = createBuffer('alternate', alternateLineCells);
    let activeBuffer = normalBuffer;
    const terminal = {
        buffer: {
            get active() {
                return activeBuffer;
            },
            alternate: alternateBuffer,
            normal: normalBuffer,
            onBufferChange: (callback: (buffer: IBuffer) => void) => {
                bufferChangeCallbacks.push(callback);
                return { dispose: vi.fn() };
            },
        },
        get cols() {
            return terminalColumns;
        },
        options: { linkHandler: null },
        parser: {
            registerOscHandler: (identifier: number, handler: typeof osc8Handler) => {
                if (identifier === 8) osc8Handler = handler;
                return { dispose: vi.fn() };
            },
        },
        registerLinkProvider: (value: ILinkProvider) => {
            provider = value;
            return { dispose };
        },
        registerMarker: (cursorYOffset = 0) => {
            const callbacks: Array<() => void> = [];
            const marker = {
                id: (markerId += 1),
                isDisposed: false,
                line: cursorLine + cursorYOffset,
                dispose: () => {
                    if (marker.isDisposed) return;
                    marker.isDisposed = true;
                    marker.line = -1;
                    for (const callback of callbacks) callback();
                },
                onDispose: (callback: () => void) => {
                    callbacks.push(callback);
                    return { dispose: vi.fn() };
                },
            };
            const typedMarker = marker as unknown as IMarker;
            markers.push(typedMarker);
            return typedMarker;
        },
        get rows() {
            return terminalRows;
        },
    } as unknown as Terminal;
    return {
        dispose,
        disposeMarkersAtLine(line: number): void {
            for (const marker of markers) if (marker.line === line) marker.dispose();
        },
        links(bufferLineNumber = 1): Promise<ILink[] | undefined> {
            return new Promise((resolve) => provider?.provideLinks(bufferLineNumber, resolve));
        },
        osc8(data: string): boolean | undefined {
            const result = osc8Handler?.(data);
            if (result instanceof Promise) throw new Error('Expected synchronous OSC test handler');
            return result;
        },
        reflowNormal(lines: readonly string[], columns: number): void {
            lineCells.splice(0, lineCells.length, ...lines.map(cellsFor));
            lineWrapped.splice(0, lineWrapped.length, ...lines.map((_, index) => index > 0));
            terminalColumns = columns;
        },
        setCursor(line: number, column: number): void {
            cursorLine = line;
            cursorColumn = column;
        },
        setActiveBuffer(type: 'alternate' | 'normal'): void {
            activeBuffer = type === 'normal' ? normalBuffer : alternateBuffer;
            for (const callback of bufferChangeCallbacks) callback(activeBuffer as IBuffer);
        },
        setAlternateLine(line: number, value: string): void {
            alternateLineCells[line] = cellsFor(value);
        },
        setLine(line: number, value: string, isWrapped = false): void {
            lineCells[line] = cellsFor(value);
            lineWrapped[line] = isWrapped;
        },
        setSize(columns: number, rows: number): void {
            terminalColumns = columns;
            terminalRows = rows;
        },
        setViewport(line: number): void {
            viewportLine = line;
        },
        terminal,
    };
}

export function cellsFor(text: string): Array<{ chars: string; width: number }> {
    return [...text].map((chars) => ({ chars, width: 1 }));
}
