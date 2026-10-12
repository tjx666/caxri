import { describe, expect, it } from 'vitest';

import { agentChatQuestionResponse, questionOptionIndexForKey } from '../agent-chat-question-flow';

describe('questionOptionIndexForKey', () => {
    it('maps digits 1 to 9 onto existing options only', () => {
        expect(questionOptionIndexForKey('1', 2)).toBe(0);
        expect(questionOptionIndexForKey('2', 2)).toBe(1);
        expect(questionOptionIndexForKey('3', 2)).toBeUndefined();
        expect(questionOptionIndexForKey('0', 2)).toBeUndefined();
        expect(questionOptionIndexForKey('a', 2)).toBeUndefined();
    });
});

describe('agentChatQuestionResponse', () => {
    it('sends the answered questions and cancels when nothing was answered', () => {
        expect(agentChatQuestionResponse({ scope: ['Narrow'] })).toEqual({
            kind: 'answers',
            answers: { scope: ['Narrow'] },
        });
        expect(agentChatQuestionResponse({})).toEqual({ kind: 'decision', decision: 'cancel' });
    });
});
