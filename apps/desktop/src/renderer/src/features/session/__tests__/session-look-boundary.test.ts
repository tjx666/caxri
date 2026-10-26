import { describe, expect, it } from 'vitest';

import {
    advanceSessionLook,
    dismissSessionReturn,
    initialSessionLookState,
} from '../session-look-boundary';

describe('advanceSessionLook', () => {
    it('has no absence for a Session looked at the first time', () => {
        const state = advanceSessionLook(initialSessionLookState, 'a', 10);
        expect(state.watching).toBe('a');
        expect(state.returns).toEqual({});
    });

    it('records the leave time and freezes the absence on return', () => {
        let state = advanceSessionLook(initialSessionLookState, 'a', 10);
        state = advanceSessionLook(state, 'b', 20);
        expect(state.leftAt).toEqual({ a: 20 });
        state = advanceSessionLook(state, 'a', 50);
        expect(state.returns).toEqual({ a: { boundary: 20, capturedAt: 50 } });
        expect(state.leftAt.a).toBeUndefined();
    });

    it('treats a blurred window as leaving and clears the hint when leaving again', () => {
        let state = advanceSessionLook(
            advanceSessionLook(initialSessionLookState, 'a', 1),
            undefined,
            5,
        );
        state = advanceSessionLook(state, 'a', 9);
        expect(state.returns.a).toEqual({ boundary: 5, capturedAt: 9 });
        state = advanceSessionLook(state, undefined, 12);
        expect(state.returns.a).toBeUndefined();
    });

    it('dismisses a return', () => {
        let state = advanceSessionLook(
            advanceSessionLook(initialSessionLookState, 'a', 1),
            undefined,
            5,
        );
        state = dismissSessionReturn(advanceSessionLook(state, 'a', 9), 'a');
        expect(state.returns).toEqual({});
    });

    it('falls back to the persisted boundary for a Session not yet left in this window', () => {
        const state = advanceSessionLook(initialSessionLookState, 'a', 50, 20);
        expect(state.returns).toEqual({ a: { boundary: 20, capturedAt: 50 } });
    });

    it('prefers an in-window leave over the persisted boundary', () => {
        let state = advanceSessionLook(initialSessionLookState, 'a', 10, 1);
        state = advanceSessionLook(state, undefined, 30);
        state = advanceSessionLook(state, 'a', 40, 1);
        expect(state.returns.a).toEqual({ boundary: 30, capturedAt: 40 });
    });
});
