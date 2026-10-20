import { describe, expect, it } from 'vitest';

import { SessionTurnWindows, TURN_WINDOW_SKEW_MS } from '../turn-windows';

function windows() {
    const clock = { now: 1000 };
    return { clock, turns: new SessionTurnWindows(() => clock.now) };
}

describe('SessionTurnWindows', () => {
    it('covers a finished turn and the skew around it, but not the gap after', () => {
        const { clock, turns } = windows();
        turns.observe({ sessionId: 's', from: 'idle', to: 'running' });
        clock.now = 2000;
        turns.observe({ sessionId: 's', from: 'running', to: 'completed' });

        expect(turns.contains('s', 1500)).toBe(true);
        expect(turns.contains('s', 2000 + TURN_WINDOW_SKEW_MS)).toBe(true);
        expect(turns.contains('s', 2000 + TURN_WINDOW_SKEW_MS + 1)).toBe(false);
        expect(turns.contains('s', 1000 - TURN_WINDOW_SKEW_MS - 1)).toBe(false);
    });

    it('treats a still-running turn as open-ended', () => {
        const { turns } = windows();
        turns.observe({ sessionId: 's', from: 'idle', to: 'running' });

        expect(turns.contains('s', 999_999)).toBe(true);
    });

    it('keeps a permission wait inside the same turn only through the running spans', () => {
        const { clock, turns } = windows();
        turns.observe({ sessionId: 's', from: 'idle', to: 'running' });
        clock.now = 2000;
        turns.observe({ sessionId: 's', from: 'running', to: 'waiting' });
        clock.now = 60_000;
        turns.observe({ sessionId: 's', from: 'waiting', to: 'running' });

        expect(turns.contains('s', 30_000)).toBe(false);
        expect(turns.contains('s', 61_000)).toBe(true);
    });

    it('knows nothing about a Session it never watched', () => {
        expect(windows().turns.contains('other', 1000)).toBe(false);
    });
});
