import { describe, expect, it } from 'vitest';

import {
    agentChatQuestionResponse,
    questionCardHeadings,
    questionFormPrimaryAction,
    questionOptionIndexForArrow,
    questionOptionIndexForKey,
    questionPanelKeyAction,
} from './agent-chat-question-flow';

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
    it('moves to the next question the user has not opened yet', () => {
        expect(questionFormPrimaryAction(3, 0, new Set([0]))).toEqual({ kind: 'next', index: 1 });
        expect(questionFormPrimaryAction(3, 0, new Set([0, 1]))).toEqual({
            kind: 'next',
            index: 2,
        });
    });

    it('wraps to an earlier unseen question', () => {
        expect(questionFormPrimaryAction(3, 2, new Set([2]))).toEqual({ kind: 'next', index: 0 });
    });

    it('submits once every question has been opened', () => {
        expect(questionFormPrimaryAction(3, 2, new Set([0, 1, 2]))).toEqual({ kind: 'submit' });
        expect(questionFormPrimaryAction(1, 0, new Set([0]))).toEqual({ kind: 'submit' });
    });
});

describe('questionCardHeadings', () => {
    it("joins a lone question's header onto the title line", () => {
        expect(questionCardHeadings('Codex has a question', 1, 'Color')).toEqual({
            title: 'Codex has a question · Color',
            questionHeader: undefined,
        });
    });

    it('keeps each header with its own question when there are several', () => {
        expect(questionCardHeadings('Codex has 3 questions', 3, 'Split')).toEqual({
            title: 'Codex has 3 questions',
            questionHeader: 'Split',
        });
    });

    it('leaves the title alone for a question without a header', () => {
        expect(questionCardHeadings('Codex has a question', 1, undefined)).toEqual({
            title: 'Codex has a question',
            questionHeader: undefined,
        });
    });
});

describe('questionPanelKeyAction', () => {
    const single = { cursor: 0, isIgnored: false, isMulti: false, optionCount: 2 };
    const multi = { ...single, isMulti: true };

    it('picks with a digit, reaches the typed row past the last option, and moves with arrows', () => {
        expect(questionPanelKeyAction('2', single)).toEqual({ kind: 'pick', index: 1 });
        expect(questionPanelKeyAction('3', single)).toEqual({ kind: 'typed' });
        expect(questionPanelKeyAction('ArrowDown', single)).toEqual({ kind: 'move', index: 1 });
        expect(questionPanelKeyAction('x', single)).toBeUndefined();
    });

    it('moves on with Enter only in a multiSelect question, whose rows are checkboxes', () => {
        expect(questionPanelKeyAction('Enter', multi)).toEqual({ kind: 'advance' });
        expect(questionPanelKeyAction('Enter', single)).toBeUndefined();
    });

    it('leaves modified keys and typing in the free-text input alone', () => {
        expect(questionPanelKeyAction('1', { ...single, isIgnored: true })).toBeUndefined();
    });
});
