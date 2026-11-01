import { clamp } from 'es-toolkit';

/**
 * Which request the turn chart reads out: the column under the pointer or the keyboard cursor, plus a column the reader
 * pinned with a click or Enter. A pinned column outranks the pointer, so leaving the chart or moving over other columns
 * keeps the readout the reader chose.
 */
export interface TurnChartFocus {
    /**
     * The column under the pointer or the keyboard cursor, `undefined` when neither is on the chart.
     */
    cursor?: number;
    /**
     * The column the reader pinned, `undefined` when none.
     */
    pinned?: number;
    /**
     * Whether the last change came from the keyboard. Only keyboard moves are announced to screen readers: announcing
     * every pointer move would flood them.
     */
    isKeyboard: boolean;
}

export const INITIAL_TURN_CHART_FOCUS: TurnChartFocus = { isKeyboard: false };

/**
 * The column the readout shows, or `undefined` for the latest request.
 */
export function turnChartFocusIndex(focus: TurnChartFocus): number | undefined {
    return focus.pinned ?? focus.cursor;
}

/**
 * The pointer moved over `column`.
 */
export function focusTurnChartPointer(focus: TurnChartFocus, column: number): TurnChartFocus {
    return { ...focus, cursor: column, isKeyboard: false };
}

/**
 * The pointer left the chart or the chart lost focus; a pinned column stays.
 */
export function releaseTurnChartCursor(focus: TurnChartFocus): TurnChartFocus {
    return { ...focus, cursor: undefined, isKeyboard: false };
}

/**
 * An arrow, Home, or End key moved the cursor to `column`. A pinned column follows, so the pin does not hide the move.
 */
export function moveTurnChartKeyboard(
    focus: TurnChartFocus,
    column: number,
    count: number,
): TurnChartFocus {
    const target = clamp(column, 0, count - 1);
    return {
        cursor: target,
        pinned: focus.pinned === undefined ? undefined : target,
        isKeyboard: true,
    };
}

/**
 * A click or Enter on `column`: pins it, or unpins when it is already the pinned one.
 */
export function toggleTurnChartPin(
    focus: TurnChartFocus,
    column: number,
    isKeyboard: boolean,
): TurnChartFocus {
    return { ...focus, pinned: focus.pinned === column ? undefined : column, isKeyboard };
}
