import { describe, expect, it } from 'vitest';

import type { ChartCursorLayout } from './chart-cursor';
import { moveChartCursor } from './chart-cursor';

const bars: ChartCursorLayout = { kind: 'linear', count: 24 };
/**
 * Three full week columns plus two days of the current week: 23 non-future days.
 */
const grid: ChartCursorLayout = { kind: 'grid', count: 23, rows: 7 };

const to = (cursor: number | undefined) => ({ handled: true, cursor });

describe('moveChartCursor', () => {
    it('enters item mode at the latest item on the first arrow and at either end on Home or End', () => {
        expect(moveChartCursor(bars, undefined, 'ArrowLeft')).toEqual(to(23));
        expect(moveChartCursor(bars, undefined, 'ArrowRight')).toEqual(to(23));
        expect(moveChartCursor(grid, undefined, 'ArrowUp')).toEqual(to(22));
        expect(moveChartCursor(bars, undefined, 'Home')).toEqual(to(0));
        expect(moveChartCursor(grid, 3, 'End')).toEqual(to(22));
    });

    it('steps a bar series by one item and stops at either end', () => {
        expect(moveChartCursor(bars, 5, 'ArrowLeft')).toEqual(to(4));
        expect(moveChartCursor(bars, 5, 'ArrowRight')).toEqual(to(6));
        expect(moveChartCursor(bars, 0, 'ArrowLeft')).toEqual(to(0));
        expect(moveChartCursor(bars, 23, 'ArrowRight')).toEqual(to(23));
    });

    it('leaves Up and Down to the page on a bar series', () => {
        expect(moveChartCursor(bars, 5, 'ArrowUp')).toEqual({ handled: false });
        expect(moveChartCursor(bars, 5, 'ArrowDown')).toEqual({ handled: false });
    });

    it('moves across week columns with Left and Right and along weekdays with Up and Down', () => {
        expect(moveChartCursor(grid, 9, 'ArrowLeft')).toEqual(to(2));
        expect(moveChartCursor(grid, 9, 'ArrowRight')).toEqual(to(16));
        expect(moveChartCursor(grid, 9, 'ArrowUp')).toEqual(to(8));
        expect(moveChartCursor(grid, 9, 'ArrowDown')).toEqual(to(10));
    });

    it('keeps Up and Down inside the week column instead of wrapping into the next week', () => {
        expect(moveChartCursor(grid, 7, 'ArrowUp')).toEqual(to(7));
        expect(moveChartCursor(grid, 13, 'ArrowDown')).toEqual(to(13));
    });

    it('stays put when the next column has no such day yet or there is no previous column', () => {
        expect(moveChartCursor(grid, 18, 'ArrowRight')).toEqual(to(18));
        expect(moveChartCursor(grid, 22, 'ArrowDown')).toEqual(to(22));
        expect(moveChartCursor(grid, 4, 'ArrowLeft')).toEqual(to(4));
    });

    it('clamps a cursor left past the end of a series that shrank', () => {
        expect(moveChartCursor(bars, 40, 'ArrowLeft')).toEqual(to(22));
    });

    it('returns to the summary on Escape and leaves Escape alone outside item mode', () => {
        expect(moveChartCursor(bars, 5, 'Escape')).toEqual(to(undefined));
        expect(moveChartCursor(bars, undefined, 'Escape')).toEqual({ handled: false });
    });

    it('ignores other keys and an empty chart', () => {
        expect(moveChartCursor(bars, 5, 'Tab')).toEqual({ handled: false });
        expect(moveChartCursor({ kind: 'linear', count: 0 }, undefined, 'ArrowLeft')).toEqual({
            handled: false,
        });
    });
});
