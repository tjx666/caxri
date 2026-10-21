import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nextQuietChange, startQuietWindow } from './use-is-quiet-since-change';

describe('startQuietWindow', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('reports not quiet at once and quiet after the window passes', () => {
        const reports: boolean[] = [];
        startQuietWindow(1500, (isQuiet) => reports.push(isQuiet));
        expect(reports).toEqual([false]);
        vi.advanceTimersByTime(1499);
        expect(reports).toEqual([false]);
        vi.advanceTimersByTime(1);
        expect(reports).toEqual([false, true]);
    });

    it('stays not quiet while changes keep arriving inside the window', () => {
        const reports: boolean[] = [];
        const report = (isQuiet: boolean) => reports.push(isQuiet);
        let stop = startQuietWindow(1500, report);
        for (let tick = 0; tick < 5; tick += 1) {
            vi.advanceTimersByTime(1000);
            stop();
            stop = startQuietWindow(1500, report);
        }
        expect(reports.every((isQuiet) => !isQuiet)).toBe(true);
        vi.advanceTimersByTime(1500);
        expect(reports.at(-1)).toBe(true);
    });
});

describe('nextQuietChange', () => {
    it('keeps the verdict while the value holds, even after the quiet window restarts', () => {
        const rolled = nextQuietChange({ value: 1, isQuiet: true }, 2, true);
        expect(rolled).toEqual({ value: 2, isQuiet: true });
        expect(nextQuietChange(rolled, 2, false)).toBe(rolled);
    });

    it('decides a new change from whether the value was quiet before it', () => {
        expect(nextQuietChange({ value: 2, isQuiet: true }, 3, false)).toEqual({
            value: 3,
            isQuiet: false,
        });
        expect(nextQuietChange({ value: 3, isQuiet: false }, 4, true)).toEqual({
            value: 4,
            isQuiet: true,
        });
    });
});
