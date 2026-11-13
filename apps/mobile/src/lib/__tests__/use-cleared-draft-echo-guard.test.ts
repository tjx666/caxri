import { describe, expect, it } from 'vitest';

import {
    CLEARED_DRAFT_ECHO_WINDOW_MS,
    clearedDraft,
    isClearedDraftEcho,
} from '../use-cleared-draft-echo-guard';

describe('clearedDraft', () => {
    it('names the text a Send cleared and when', () => {
        expect(clearedDraft('缓存不收钱，另一家不清楚 ', '', 1000)).toEqual({
            at: 1000,
            text: '缓存不收钱，另一家不清楚',
        });
    });

    it('ignores writes that leave text in the draft', () => {
        expect(clearedDraft('hello', 'hello!', 1000)).toBeUndefined();
    });

    it('ignores clearing a draft of only whitespace', () => {
        expect(clearedDraft('\n ', '', 1000)).toBeUndefined();
    });
});

describe('isClearedDraftEcho', () => {
    const cleared = { at: 1000, text: '缓存不收钱' };

    it('treats the sent text handed back with a trailing newline as an echo', () => {
        expect(isClearedDraftEcho('缓存不收钱\n', cleared, 1000)).toBe(true);
    });

    it('treats the sent text handed back a few frames later as an echo', () => {
        expect(isClearedDraftEcho('缓存不收钱', cleared, 1000 + CLEARED_DRAFT_ECHO_WINDOW_MS)).toBe(
            true,
        );
    });

    it('keeps the user retyping a one-letter message after the window', () => {
        expect(
            isClearedDraftEcho('a', { at: 1000, text: 'a' }, 1001 + CLEARED_DRAFT_ECHO_WINDOW_MS),
        ).toBe(false);
    });

    it('treats the sent text short of the word the IME was still composing as an echo', () => {
        expect(isClearedDraftEcho('最多读 key', { at: 1000, text: '最多读 keys' }, 1000 + 16)).toBe(
            true,
        );
    });

    it('keeps a short prefix of the sent text the user typed right after it', () => {
        expect(isClearedDraftEcho('缓存', cleared, 1000)).toBe(false);
    });

    it('keeps a partial echo that arrives after the window', () => {
        expect(
            isClearedDraftEcho(
                '最多读 key',
                { at: 1000, text: '最多读 keys' },
                1001 + CLEARED_DRAFT_ECHO_WINDOW_MS,
            ),
        ).toBe(false);
    });

    it('keeps the user typing something new', () => {
        expect(isClearedDraftEcho('n', cleared, 1000)).toBe(false);
    });

    it('keeps every change when nothing was cleared', () => {
        expect(isClearedDraftEcho('缓存不收钱', undefined, 1000)).toBe(false);
    });
});
