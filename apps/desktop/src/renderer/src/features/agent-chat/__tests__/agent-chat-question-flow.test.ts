import type { AgentChatRequest } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    answerAgentChatQuestion,
    questionOptionIndexForKey,
    recommendedQuestionOptionIndex,
} from '../agent-chat-question-flow';

const option = (label: string) => ({ label, description: '' });

const request: Extract<AgentChatRequest, { kind: 'question' }> = {
    id: 'request-1',
    kind: 'question',
    questions: [
        {
            id: 'scope',
            header: 'Scope',
            question: 'Which scope?',
            options: [option('Narrow'), option('Wide (Recommended)')],
            allowsOther: true,
        },
        {
            id: 'tests',
            header: 'Tests',
            question: 'Add tests?',
            options: [option('Yes'), option('No')],
            allowsOther: false,
        },
    ],
};

describe('recommendedQuestionOptionIndex', () => {
    it('preselects only the recommended option', () => {
        expect(recommendedQuestionOptionIndex(request.questions[0].options)).toBe(1);
        expect(recommendedQuestionOptionIndex(request.questions[1].options)).toBeUndefined();
        expect(recommendedQuestionOptionIndex([])).toBeUndefined();
    });
});

describe('questionOptionIndexForKey', () => {
    it('maps digits 1 to 9 onto existing options only', () => {
        expect(questionOptionIndexForKey('1', 2)).toBe(0);
        expect(questionOptionIndexForKey('2', 2)).toBe(1);
        expect(questionOptionIndexForKey('3', 2)).toBeUndefined();
        expect(questionOptionIndexForKey('0', 2)).toBeUndefined();
        expect(questionOptionIndexForKey('a', 2)).toBeUndefined();
    });
});

describe('answerAgentChatQuestion', () => {
    it('moves to the next question, then sends every answer from the last one', () => {
        const first = answerAgentChatQuestion(request, {}, 0, 'Wide (Recommended)');
        expect(first).toEqual({
            kind: 'next',
            answers: { scope: ['Wide (Recommended)'] },
            index: 1,
        });
        if (first.kind !== 'next') throw new Error('expected the next question');
        expect(answerAgentChatQuestion(request, first.answers, 1, ' Yes ')).toEqual({
            kind: 'respond',
            response: {
                kind: 'answers',
                answers: { scope: ['Wide (Recommended)'], tests: ['Yes'] },
            },
        });
    });

    it('leaves a skipped question out and cancels when every question was skipped', () => {
        expect(answerAgentChatQuestion(request, { scope: ['Narrow'] }, 1, undefined)).toEqual({
            kind: 'respond',
            response: { kind: 'answers', answers: { scope: ['Narrow'] } },
        });
        expect(answerAgentChatQuestion(request, {}, 1, '  ')).toEqual({
            kind: 'respond',
            response: { kind: 'decision', decision: 'cancel' },
        });
    });
});
