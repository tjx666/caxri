import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    claimSidebarDetailCard,
    isSidebarDetailCardWarm,
    SIDEBAR_DETAIL_CARD_DELAY_MS,
    sidebarDetailCardDelay,
    sidebarDetailCardMotionClassName,
} from '../sidebar-detail-card-handoff';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
});

describe('sidebar detail card handoff', () => {
    it('closes the previous card at once when the next one opens, and keeps the list warm across the gap', () => {
        expect(isSidebarDetailCardWarm()).toBe(false);
        const closeFirst = vi.fn();
        const releaseFirst = claimSidebarDetailCard(closeFirst);
        expect(isSidebarDetailCardWarm()).toBe(true);

        // The pointer reaches the next row: its card replaces the first without waiting out a close delay.
        const releaseSecond = claimSidebarDetailCard(vi.fn());
        expect(closeFirst).toHaveBeenCalledOnce();
        // The replaced card's own cleanup must not cool the list the second card now holds.
        releaseFirst();
        vi.advanceTimersByTime(1_000);
        expect(isSidebarDetailCardWarm()).toBe(true);

        // Leaving the list: a row reached within the handoff window still opens at once, later ones wait again.
        releaseSecond();
        vi.advanceTimersByTime(200);
        expect(isSidebarDetailCardWarm()).toBe(true);
        vi.advanceTimersByTime(200);
        expect(isSidebarDetailCardWarm()).toBe(false);
    });

    it('picks the cold delay or none at read time, with nothing to subscribe to', () => {
        expect(sidebarDetailCardDelay()).toBe(SIDEBAR_DETAIL_CARD_DELAY_MS);
        const release = claimSidebarDetailCard(vi.fn());
        expect(sidebarDetailCardDelay()).toBe(0);
        release();
        vi.advanceTimersByTime(1_000);
        expect(sidebarDetailCardDelay()).toBe(SIDEBAR_DETAIL_CARD_DELAY_MS);
    });

    it('drops the exit animation always and the enter animation only for a card that follows another', () => {
        expect(sidebarDetailCardMotionClassName(false)).toBe('data-closed:animate-none!');
        expect(sidebarDetailCardMotionClassName(true)).toContain('data-open:animate-none!');
    });
});
