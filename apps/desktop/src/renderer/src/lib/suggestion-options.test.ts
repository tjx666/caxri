import { describe, expect, it } from 'vitest';

import { mentionAtCaret, suggestionMenuKeyAction, suggestionOptionId } from './suggestion-options';

describe('mentionAtCaret', () => {
    it('finds the @ word that ends at the caret', () => {
        expect(mentionAtCaret('see @log', 8)).toEqual({ start: 4, end: 8, query: 'log' });
        expect(mentionAtCaret('@', 1)).toEqual({ start: 0, end: 1, query: '' });
        expect(mentionAtCaret('answer @', 8)).toEqual({ start: 7, end: 8, query: '' });
        expect(mentionAtCaret('line one\n@plan', 14)).toEqual({
            start: 9,
            end: 14,
            query: 'plan',
        });
    });

    it('follows the caret rather than the end of the text', () => {
        expect(mentionAtCaret('@tab done', 4)).toEqual({ start: 0, end: 4, query: 'tab' });
    });

    it('requires the @ to open the text or follow whitespace', () => {
        expect(mentionAtCaret('mail@host', 9)).toBeUndefined();
        expect(mentionAtCaret('mail me@example.com', 19)).toBeUndefined();
        expect(mentionAtCaret('@a@b', 4)).toBeUndefined();
    });

    it('ends the mention at whitespace', () => {
        expect(mentionAtCaret('@log done', 9)).toBeUndefined();
        expect(mentionAtCaret('@log ', 5)).toBeUndefined();
    });
});

describe('suggestionOptionId', () => {
    it('scopes a row id to its list', () => {
        expect(suggestionOptionId('list-1', 'item-a')).toBe('list-1-item-a');
    });
});

describe('suggestionMenuKeyAction', () => {
    it('completes on Tab and runs only on Enter', () => {
        expect(suggestionMenuKeyAction({ key: 'Tab', shiftKey: false })).toBe('complete');
        expect(suggestionMenuKeyAction({ key: 'Enter', shiftKey: false })).toBe('choose');
        expect(suggestionMenuKeyAction({ key: 'Enter', shiftKey: true })).toBeUndefined();
        expect(suggestionMenuKeyAction({ key: 'ArrowDown', shiftKey: false })).toBe('next');
        expect(suggestionMenuKeyAction({ key: 'ArrowUp', shiftKey: false })).toBe('previous');
        expect(suggestionMenuKeyAction({ key: 'Escape', shiftKey: false })).toBe('dismiss');
        expect(suggestionMenuKeyAction({ key: 'a', shiftKey: false })).toBeUndefined();
    });
});
