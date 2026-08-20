import { describe, expect, it, vi } from 'vitest';

import {
    didTerminalSizeChange,
    TerminalResizeSettler,
    terminalSizeWithScrollbarGutter,
} from '../terminal-size';

describe('Terminal scrollbar gutter', () => {
    it('reserves one text column without dropping below xterm minimum dimensions', () => {
        expect(terminalSizeWithScrollbarGutter(undefined)).toBeUndefined();
        expect(terminalSizeWithScrollbarGutter({ cols: 100, rows: 30 })).toEqual({
            cols: 99,
            rows: 30,
        });
        expect(terminalSizeWithScrollbarGutter({ cols: 2, rows: 1 })).toEqual({
            cols: 2,
            rows: 1,
        });
    });
});

describe('Terminal resize deduplication', () => {
    it('suppresses an unchanged grid while preserving either dimension change', () => {
        expect(didTerminalSizeChange(undefined, { cols: 100, rows: 30 })).toBe(true);
        expect(didTerminalSizeChange({ cols: 100, rows: 30 }, { cols: 100, rows: 30 })).toBe(false);
        expect(didTerminalSizeChange({ cols: 100, rows: 30 }, { cols: 101, rows: 30 })).toBe(true);
        expect(didTerminalSizeChange({ cols: 100, rows: 30 }, { cols: 100, rows: 31 })).toBe(true);
    });

    it('keeps sampling after an initial narrow layout so the final pane grid is applied', () => {
        const frames: Array<() => void> = [];
        const requestFrame = vi.fn((callback: () => void) => {
            frames.push(callback);
            return frames.length;
        });
        const cancelFrame = vi.fn();
        const sampledColumns = [4, 4, 80, 80];
        const appliedColumns: number[] = [];
        const settler = new TerminalResizeSettler(
            () => appliedColumns.push(sampledColumns.shift() ?? 80),
            requestFrame,
            cancelFrame,
            4,
        );

        settler.schedule();
        while (frames.length > 0) frames.shift()!();

        expect(appliedColumns).toEqual([4, 4, 80, 80]);
        expect(requestFrame).toHaveBeenCalledTimes(4);
        expect(cancelFrame).not.toHaveBeenCalled();
    });
});
