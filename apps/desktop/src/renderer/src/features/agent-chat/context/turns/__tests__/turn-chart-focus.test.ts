import { describe, expect, it } from 'vitest';

import {
    focusTurnChartPointer,
    INITIAL_TURN_CHART_FOCUS,
    moveTurnChartKeyboard,
    releaseTurnChartCursor,
    toggleTurnChartPin,
    turnChartFocusIndex,
} from '../turn-chart-focus';

describe('turn chart focus', () => {
    it('reads the pointer column and drops it on leave', () => {
        const hovered = focusTurnChartPointer(INITIAL_TURN_CHART_FOCUS, 3);
        expect(turnChartFocusIndex(hovered)).toBe(3);
        expect(hovered.isKeyboard).toBe(false);
        expect(turnChartFocusIndex(releaseTurnChartCursor(hovered))).toBeUndefined();
    });

    it('keeps a pinned column through pointer moves and leave, and unpins on a second toggle', () => {
        const pinned = toggleTurnChartPin(
            focusTurnChartPointer(INITIAL_TURN_CHART_FOCUS, 2),
            2,
            false,
        );
        expect(turnChartFocusIndex(focusTurnChartPointer(pinned, 5))).toBe(2);
        expect(turnChartFocusIndex(releaseTurnChartCursor(pinned))).toBe(2);
        const unpinned = toggleTurnChartPin(pinned, 2, false);
        expect(unpinned.pinned).toBeUndefined();
    });

    it('announces keyboard moves only, and a pin follows the keyboard', () => {
        const moved = moveTurnChartKeyboard(INITIAL_TURN_CHART_FOCUS, 4, 10);
        expect(moved.isKeyboard).toBe(true);
        expect(moved.pinned).toBeUndefined();
        const pinned = toggleTurnChartPin(moved, 4, true);
        expect(turnChartFocusIndex(moveTurnChartKeyboard(pinned, 99, 10))).toBe(9);
        expect(focusTurnChartPointer(moved, 1).isKeyboard).toBe(false);
    });
});
