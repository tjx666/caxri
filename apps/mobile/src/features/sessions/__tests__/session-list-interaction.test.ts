import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionListInteraction } from '../session-list-interaction';

afterEach(() => vi.useRealTimers());

describe('Session list interaction', () => {
    it('waits through drag-to-momentum handoff before applying pending order', () => {
        vi.useFakeTimers();
        const begin = vi.fn();
        const finish = vi.fn();
        const interaction = createSessionListInteraction(begin, finish);
        interaction.touchStart();
        interaction.dragStart();
        interaction.touchEnd();
        interaction.dragEnd();
        interaction.momentumStart();
        for (let index = 0; index < 3; index += 1) {
            vi.advanceTimersByTime(100);
            interaction.scroll();
        }
        expect(finish).not.toHaveBeenCalled();
        interaction.momentumEnd();
        vi.advanceTimersByTime(120);
        expect(begin).toHaveBeenCalledOnce();
        expect(finish).toHaveBeenCalledOnce();
    });

    it('keeps freezing if the user touches again before momentum ends', () => {
        vi.useFakeTimers();
        const finish = vi.fn();
        const interaction = createSessionListInteraction(vi.fn(), finish);
        interaction.touchStart();
        interaction.touchEnd();
        interaction.momentumStart();
        interaction.touchStart();
        interaction.momentumEnd();
        vi.advanceTimersByTime(300);
        expect(finish).not.toHaveBeenCalled();
        interaction.touchEnd();
        interaction.scroll();
        vi.advanceTimersByTime(119);
        expect(finish).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(finish).toHaveBeenCalledOnce();
    });

    it('releases a canceled touch without requiring a momentum event', () => {
        vi.useFakeTimers();
        const finish = vi.fn();
        const interaction = createSessionListInteraction(vi.fn(), finish);
        interaction.touchStart();
        interaction.dragStart();
        interaction.touchCancel();
        vi.advanceTimersByTime(120);
        expect(finish).toHaveBeenCalledOnce();
    });

    it('recovers if native momentum end is lost after the last scroll event', () => {
        vi.useFakeTimers();
        const finish = vi.fn();
        const interaction = createSessionListInteraction(vi.fn(), finish);
        interaction.touchStart();
        interaction.touchEnd();
        interaction.momentumStart();
        interaction.scroll();
        vi.advanceTimersByTime(160);
        expect(finish).toHaveBeenCalledOnce();
    });

    it('releases the list when navigation disposes an active touch before idle', () => {
        vi.useFakeTimers();
        const finish = vi.fn();
        const interaction = createSessionListInteraction(vi.fn(), finish);
        interaction.touchStart();
        interaction.touchEnd();
        interaction.dispose();
        expect(finish).toHaveBeenCalledOnce();
        vi.runAllTimers();
        expect(finish).toHaveBeenCalledOnce();
    });
});
