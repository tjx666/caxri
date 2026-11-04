import { describe, expect, it } from 'vitest';

import {
    clearDelegationAnswerDraft,
    getDelegationAnswerDraft,
    setDelegationAnswerDraft,
} from '../delegation-answer-drafts';

describe('delegation answer drafts', () => {
    it('keeps a draft per delegation until it is cleared', () => {
        setDelegationAnswerDraft('a', 'yes');
        setDelegationAnswerDraft('b', 'no');
        expect(getDelegationAnswerDraft('a')).toBe('yes');
        expect(getDelegationAnswerDraft('b')).toBe('no');
        clearDelegationAnswerDraft('a');
        expect(getDelegationAnswerDraft('a')).toBe('');
        expect(getDelegationAnswerDraft('b')).toBe('no');
        clearDelegationAnswerDraft('b');
    });

    it('drops an emptied draft', () => {
        setDelegationAnswerDraft('c', 'x');
        setDelegationAnswerDraft('c', '');
        expect(getDelegationAnswerDraft('c')).toBe('');
    });
});
