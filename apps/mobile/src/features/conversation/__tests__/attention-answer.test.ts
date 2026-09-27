import { describe, expect, it } from 'vitest';

import {
    composeAttentionAnswer,
    emptyAttentionAnswerDraft,
    isAttentionAnswerDraftEmpty,
    toggleAttentionOption,
} from '../attention-answer';

describe('toggleAttentionOption', () => {
    it('replaces the whole selection for a single-select question', () => {
        expect(toggleAttentionOption(['A'], 'B', false)).toEqual(['B']);
        expect(toggleAttentionOption([], 'A', false)).toEqual(['A']);
    });

    it('adds a new label for a multi-select question', () => {
        expect(toggleAttentionOption([], 'A', true)).toEqual(['A']);
        expect(toggleAttentionOption(['A'], 'B', true)).toEqual(['A', 'B']);
    });

    it('removes an already-selected label for a multi-select question', () => {
        expect(toggleAttentionOption(['A', 'B'], 'A', true)).toEqual(['B']);
    });

    it('never lets a label containing a comma corrupt an unrelated selection', () => {
        expect(toggleAttentionOption(['Fix bug, then ship'], 'Fix bug, then ship', true)).toEqual(
            [],
        );
    });
});

describe('composeAttentionAnswer', () => {
    it('returns an empty string when nothing is selected or typed', () => {
        expect(composeAttentionAnswer([], '')).toBe('');
        expect(composeAttentionAnswer([], ' '.repeat(3))).toBe('');
    });

    it('joins selected options with a comma', () => {
        expect(composeAttentionAnswer(['A', 'B'], '')).toBe('A, B');
    });

    it('appends trimmed free text after the selected options', () => {
        expect(composeAttentionAnswer(['A'], '  more detail  ')).toBe('A, more detail');
        expect(composeAttentionAnswer([], 'just text')).toBe('just text');
    });

    it('preserves a comma embedded inside one option label', () => {
        expect(composeAttentionAnswer(['Fix bug, then ship'], '')).toBe('Fix bug, then ship');
    });
});

describe('isAttentionAnswerDraftEmpty', () => {
    it('is true for the empty draft', () => {
        expect(isAttentionAnswerDraftEmpty(emptyAttentionAnswerDraft())).toBe(true);
    });

    it('is false once an option is selected or text is typed', () => {
        expect(isAttentionAnswerDraftEmpty({ freeText: '', selectedOptions: ['A'] })).toBe(false);
        expect(isAttentionAnswerDraftEmpty({ freeText: 'hi', selectedOptions: [] })).toBe(false);
        expect(isAttentionAnswerDraftEmpty({ freeText: ' '.repeat(3), selectedOptions: [] })).toBe(
            true,
        );
    });
});
