import { describe, expect, it, vi } from 'vitest';

import {
    lastSourceScroll,
    publishSourceScroll,
    subscribeSourceScroll,
} from '../preview-scroll-sync';

describe('preview scroll sync', () => {
    it('delivers a position only to the listeners of that document', () => {
        const readme = vi.fn();
        const guide = vi.fn();
        const unsubscribeReadme = subscribeSourceScroll('/p/README.md', readme);
        const unsubscribeGuide = subscribeSourceScroll('/p/guide.md', guide);

        publishSourceScroll('/p/README.md', 12);

        expect(readme).toHaveBeenCalledWith(12);
        expect(guide).not.toHaveBeenCalled();
        unsubscribeReadme();
        unsubscribeGuide();
    });

    it('drops a repeated position so a scroll that settles does not re-notify', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeSourceScroll('/p/repeat.md', listener);

        publishSourceScroll('/p/repeat.md', 4);
        publishSourceScroll('/p/repeat.md', 4);
        publishSourceScroll('/p/repeat.md', 5);

        expect(listener.mock.calls).toEqual([[4], [5]]);
        unsubscribe();
    });

    it('replays the last position to a preview opened after the editor scrolled', () => {
        const unsubscribe = subscribeSourceScroll('/p/replay.md', () => {});
        publishSourceScroll('/p/replay.md', 30);

        expect(lastSourceScroll('/p/replay.md')).toBe(30);
        unsubscribe();
    });

    it('forgets a document once its last listener leaves', () => {
        const unsubscribe = subscribeSourceScroll('/p/forget.md', () => {});
        publishSourceScroll('/p/forget.md', 7);
        unsubscribe();

        expect(lastSourceScroll('/p/forget.md')).toBeUndefined();
    });

    it('stops delivering to a listener that unsubscribed while another stays', () => {
        const staying = vi.fn();
        const leaving = vi.fn();
        const unsubscribeStaying = subscribeSourceScroll('/p/shared.md', staying);
        const unsubscribeLeaving = subscribeSourceScroll('/p/shared.md', leaving);

        unsubscribeLeaving();
        publishSourceScroll('/p/shared.md', 9);

        expect(staying).toHaveBeenCalledWith(9);
        expect(leaving).not.toHaveBeenCalled();
        unsubscribeStaying();
    });

    it('delivers a position to a later listener when an earlier one throws', () => {
        const failing = vi.fn(() => {
            throw new Error('scroll listener failure');
        });
        const surviving = vi.fn();
        const unsubscribeFailing = subscribeSourceScroll('/p/fanout.md', failing);
        const unsubscribeSurviving = subscribeSourceScroll('/p/fanout.md', surviving);
        vi.spyOn(console, 'error').mockImplementation(() => {});

        publishSourceScroll('/p/fanout.md', 3);

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledExactlyOnceWith(3);
        unsubscribeFailing();
        unsubscribeSurviving();
        vi.restoreAllMocks();
    });
});
