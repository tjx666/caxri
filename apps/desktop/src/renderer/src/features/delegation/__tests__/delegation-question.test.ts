import { MAX_ANSWER_TEXT_CHARS } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    canSendDelegationAnswer,
    delegationQuestionMode,
    delegationQuestionNoticeKey,
    delegationQuestionOptions,
} from '../delegation-question';

describe('delegationQuestionMode', () => {
    it('offers "I will answer" while the delegating Agent has the question', () => {
        expect(delegationQuestionMode({ waitingOn: 'parent' })).toBe('offer');
    });

    it('opens the answer field once the question escalated', () => {
        expect(delegationQuestionMode({ waitingOn: 'user' })).toBe('escalated');
    });

    it('hides the card without a question, without a task, and after a takeover', () => {
        expect(delegationQuestionMode({})).toBe('hidden');
        expect(delegationQuestionMode(undefined)).toBe('hidden');
        expect(delegationQuestionMode({ takenOverAt: 5, waitingOn: 'user' })).toBe('hidden');
    });
});

describe('delegationQuestionNoticeKey', () => {
    it('notes only an answer the Server did not deliver', () => {
        expect(delegationQuestionNoticeKey('already_answered')).toBe(
            'delegation.question.alreadyAnswered',
        );
        expect(delegationQuestionNoticeKey('cancelled')).toBe('delegation.question.cancelled');
        expect(delegationQuestionNoticeKey('answered')).toBeUndefined();
        expect(delegationQuestionNoticeKey(undefined)).toBeUndefined();
    });
});

describe('canSendDelegationAnswer', () => {
    it('rejects a blank draft and one over the answer bound', () => {
        expect(canSendDelegationAnswer('')).toBe(false);
        expect(canSendDelegationAnswer('  \n ')).toBe(false);
        expect(canSendDelegationAnswer('yes')).toBe(true);
        expect(canSendDelegationAnswer('x'.repeat(MAX_ANSWER_TEXT_CHARS))).toBe(true);
        expect(canSendDelegationAnswer('x'.repeat(MAX_ANSWER_TEXT_CHARS + 1))).toBe(false);
    });
});

describe('delegationQuestionOptions', () => {
    it('lists the offered choices, or none', () => {
        expect(delegationQuestionOptions({ options: ['a', 'b'] })).toEqual(['a', 'b']);
        expect(delegationQuestionOptions({})).toEqual([]);
        expect(delegationQuestionOptions(undefined)).toEqual([]);
    });
});
