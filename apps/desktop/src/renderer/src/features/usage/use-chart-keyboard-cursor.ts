import type { KeyboardEvent } from 'react';
import { useState } from 'react';

import type { ChartCursorLayout } from './usage-chart-cursor';
import { moveChartCursor } from './usage-chart-cursor';

interface CursorState {
    resetKey: string;
    index: number | undefined;
}

/**
 * The keyboard cursor of one focusable Usage chart (see `usage-chart-cursor.ts` for the keys). The cursor belongs to
 * `resetKey`: switching the Activity view changes what an index means, so a new key starts over at the summary rather
 * than landing on an item that does not exist. Leaving the chart also returns to the summary.
 *
 * `cursor` is clamped to the current item count, so a report refresh that shortens the series never points past it.
 */
export function useChartKeyboardCursor(layout: ChartCursorLayout, resetKey: string) {
    const [state, setState] = useState<CursorState>({ resetKey, index: undefined });
    const stored = state.resetKey === resetKey ? state.index : undefined;
    const cursor =
        stored === undefined || layout.count === 0 ? undefined : Math.min(stored, layout.count - 1);
    const onKeyDown = (event: KeyboardEvent): void => {
        const move = moveChartCursor(layout, cursor, event.key);
        if (!move.handled) return;
        event.preventDefault();
        setState({ resetKey, index: move.cursor });
    };
    const onBlur = (): void => setState({ resetKey, index: undefined });
    return { cursor, onBlur, onKeyDown };
}
