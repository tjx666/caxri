import { describe, expect, it } from 'vitest';

import {
    agentChatQuestionResponse,
    questionFormPrimaryAction,
    questionOptionIndexForArrow,
    questionOptionIndexForKey,
} from '../agent-chat-question-flow';

describe('questionOptionIndexForKey', () => {
    it('maps digits 1 to 9 onto existing options only', () => {
        expect(questionOptionIndexForKey('1', 2)).toBe(0);
        expect(questionOptionIndexForKey('2', 2)).toBe(1);
        expect(questionOptionIndexForKey('3', 2)).toBeUndefined();
        expect(questionOptionIndexForKey('0', 2)).toBeUndefined();
        expect(questionOptionIndexForKey('a', 2)).toBeUndefined();
    });
});

describe('questionOptionIndexForArrow', () => {
    it('moves the selection with wrap-around and starts from the matching end', () => {
        expect(questionOptionIndexForArrow('ArrowDown', -1, 3)).toBe(0);
        expect(questionOptionIndexForArrow('ArrowUp', -1, 3)).toBe(2);
        expect(questionOptionIndexForArrow('ArrowDown', 2, 3)).toBe(0);
        expect(questionOptionIndexForArrow('ArrowUp', 0, 3)).toBe(2);
        expect(questionOptionIndexForArrow('ArrowDown', 0, 0)).toBeUndefined();
        expect(questionOptionIndexForArrow('Enter', 0, 3)).toBeUndefined();
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

describe('questionFormPrimaryAction', () => {
    const ids = ['scope', 'tests', 'docs'];

    it('moves to the next unanswered question the user has not opened yet', () => {
        expect(questionFormPrimaryAction(ids, { scope: ['Narrow'] }, 0, new Set([0]))).toEqual({
            kind: 'next',
            index: 1,
        });
        expect(
            questionFormPrimaryAction(ids, { scope: ['Narrow'], tests: ['Yes'] }, 0, new Set([0])),
        ).toEqual({ kind: 'next', index: 2 });
    });

    it('wraps to an earlier unseen question', () => {
        expect(questionFormPrimaryAction(ids, {}, 2, new Set([2]))).toEqual({
            kind: 'next',
            index: 0,
        });
    });

    it('submits once every unanswered question has been opened or answered', () => {
        expect(
            questionFormPrimaryAction(ids, { scope: ['Narrow'] }, 2, new Set([0, 1, 2])),
        ).toEqual({ kind: 'submit' });
        expect(
            questionFormPrimaryAction(
                ids,
                { scope: ['Narrow'], tests: ['Yes'], docs: ['No'] },
                0,
                new Set([0]),
            ),
        ).toEqual({ kind: 'submit' });
        expect(questionFormPrimaryAction(['only'], {}, 0, new Set([0]))).toEqual({
            kind: 'submit',
        });
    });
});
