import { describe, expect, it } from 'vitest';

import { beginHang, endHang, initialHangState } from '../hang-policy';

describe('hang policy', () => {
    it('records the first hang with a lifetime count of one', () => {
        const started = beginHang(initialHangState, 1_000);

        expect(started.record).toEqual({ hangCount: 1 });
        expect(started.state).toEqual({ startedAtMs: 1_000, hangCount: 1 });
    });

    it('records the recovery with how long the window was blocked', () => {
        const started = beginHang(initialHangState, 1_000);
        const ended = endHang(started.state, 32_500);

        expect(ended.record).toEqual({ hangCount: 1, durationMs: 31_500 });
        expect(ended.state).toEqual({ hangCount: 1 });
    });

    it('counts a repeated unresponsive event for one continuous block only once', () => {
        const started = beginHang(initialHangState, 1_000);
        const repeated = beginHang(started.state, 40_000);

        expect(repeated.record).toBeUndefined();
        expect(repeated.state).toEqual({ startedAtMs: 1_000, hangCount: 1 });

        // The duration still measures from the original block, not the repeat.
        expect(endHang(repeated.state, 61_000).record).toEqual({
            hangCount: 1,
            durationMs: 60_000,
        });
    });

    it('ignores a responsive event with no hang in progress', () => {
        const ended = endHang(initialHangState, 1_000);

        expect(ended.record).toBeUndefined();
        expect(ended.state).toBe(initialHangState);
    });

    it('accumulates the lifetime count across separate hangs', () => {
        const first = endHang(beginHang(initialHangState, 1_000).state, 40_000);
        const second = beginHang(first.state, 100_000);

        expect(second.record).toEqual({ hangCount: 2 });
        expect(endHang(second.state, 140_000).record).toEqual({
            hangCount: 2,
            durationMs: 40_000,
        });
    });

    it('never reports a negative duration when the clock moves backwards', () => {
        const started = beginHang(initialHangState, 5_000);

        expect(endHang(started.state, 4_000).record).toEqual({ hangCount: 1, durationMs: 0 });
    });
});
