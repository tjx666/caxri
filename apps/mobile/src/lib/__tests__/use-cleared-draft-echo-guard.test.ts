import { describe, expect, it } from 'vitest';

import { clearedDraftText, isClearedDraftEcho } from '../use-cleared-draft-echo-guard';

describe('clearedDraftText', () => {
    it('names the text a Send cleared while the field still held it', () => {
        expect(clearedDraftText('缓存不收钱，另一家不清楚 ', '', '缓存不收钱，另一家不清楚 ')).toBe(
            '缓存不收钱，另一家不清楚',
        );
    });

    it('ignores a field the user emptied, since the field reported the empty text first', () => {
        expect(clearedDraftText('hello', '', '')).toBeUndefined();
    });

    it('ignores changes that leave text in the draft', () => {
        expect(clearedDraftText('hello', 'hello!', 'hello')).toBeUndefined();
    });

    it('ignores clearing a draft of only whitespace', () => {
        expect(clearedDraftText('\n ', '', '\n ')).toBeUndefined();
    });
});

describe('isClearedDraftEcho', () => {
    it('treats the sent text handed back with a trailing newline as an echo', () => {
        expect(isClearedDraftEcho('缓存不收钱\n', '缓存不收钱')).toBe(true);
    });

    it('keeps the user typing something new', () => {
        expect(isClearedDraftEcho('n', '缓存不收钱')).toBe(false);
    });

    it('keeps every change when nothing was cleared', () => {
        expect(isClearedDraftEcho('缓存不收钱', undefined)).toBe(false);
    });
});
