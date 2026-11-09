import { describe, expect, it } from 'vitest';

import {
    createPointerTrace,
    POINTER_TRACE_BAND_HEIGHT,
    POINTER_TRACE_CAPACITY,
    POINTER_TRACE_MOVE_INTERVAL_MS,
} from './pointer-trace';

function clock(start = 1000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('createPointerTrace', () => {
    it('keeps moves only inside the title-bar band, at most one per interval', () => {
        const time = clock();
        const trace = createPointerTrace(time.now);
        trace.move(10, POINTER_TRACE_BAND_HEIGHT + 1);
        trace.move(10.4, 20.6);
        time.advance(POINTER_TRACE_MOVE_INTERVAL_MS - 1);
        trace.move(30, 20);
        time.advance(1);
        trace.move(40, 20);
        expect(trace.entries()).toEqual([
            { kind: 'move', t: 1000, x: 10, y: 21 },
            { kind: 'move', t: 1150, x: 40, y: 20 },
        ]);
    });

    it('keeps presses anywhere in the window, with their target token', () => {
        const trace = createPointerTrace(clock().now);
        trace.press('pointerdown', 500, 700, 'tab-select');
        trace.window('blur');
        trace.shown('settings');
        expect(trace.entries()).toEqual([
            { kind: 'pointerdown', t: 1000, x: 500, y: 700, target: 'tab-select' },
            { kind: 'blur', t: 1000 },
            { kind: 'shown', t: 1000, surface: 'settings' },
        ]);
    });

    it('drops the oldest entries past its capacity', () => {
        const trace = createPointerTrace(clock().now);
        for (let index = 0; index <= POINTER_TRACE_CAPACITY; index += 1) {
            trace.press('click', index, 0, null);
        }
        const entries = trace.entries();
        expect(entries).toHaveLength(POINTER_TRACE_CAPACITY);
        expect(entries[0]).toMatchObject({ x: 1 });
    });
});
