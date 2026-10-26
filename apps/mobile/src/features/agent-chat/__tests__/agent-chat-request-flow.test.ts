import type { AgentChatRequest } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatQuestionAdvance,
    agentChatQuestionFooter,
    agentChatRequestDock,
} from '../agent-chat-request-flow';

type QuestionRequest = Extract<AgentChatRequest, { kind: 'question' }>;

const question = (id: string, labels: string[]): QuestionRequest['questions'][number] => ({
    id,
    header: '',
    question: `Question ${id}?`,
    options: labels.map((label) => ({ label, description: '' })),
    allowsOther: true,
});

const ask = (...questions: QuestionRequest['questions']): QuestionRequest => ({
    id: 'q',
    kind: 'question',
    questions,
});

const approval = (id: string): AgentChatRequest => ({
    id,
    kind: 'command',
    command: 'ls',
});

describe('agentChatRequestDock', () => {
    it('shows the first waiting request and counts the rest', () => {
        const requests = [approval('a'), approval('b'), approval('c')];
        expect(agentChatRequestDock(requests, new Set())).toEqual({
            currentId: 'a',
            positionLabel: '1 of 3',
        });
        expect(agentChatRequestDock(requests, new Set(['a']))).toEqual({
            currentId: 'b',
            positionLabel: '1 of 2',
        });
    });

    it('has no label for one request and nothing to show once every request is answered', () => {
        expect(agentChatRequestDock([approval('a')], new Set())).toEqual({
            currentId: 'a',
            positionLabel: undefined,
        });
        expect(agentChatRequestDock([approval('a')], new Set(['a']))).toEqual({
            currentId: undefined,
            positionLabel: undefined,
        });
        expect(agentChatRequestDock([], new Set()).currentId).toBeUndefined();
    });
});

/**
 * Every question of a three-question card opened.
 */
const ALL: ReadonlySet<number> = new Set([0, 1, 2]);

describe('agentChatQuestionFooter', () => {
    it('drops Submit for one question with options, since a tap sends it', () => {
        const request = ask(question('a', ['Red', 'Blue']));
        expect(
            agentChatQuestionFooter({ answers: {}, index: 0, request, seen: ALL, typed: {} }),
        ).toEqual({
            isBackShown: false,
            primary: undefined,
            canSubmit: false,
        });
    });

    it('shows Submit once the single question is answered by typing', () => {
        const request = ask(question('a', ['Red', 'Blue']));
        expect(
            agentChatQuestionFooter({
                answers: { a: ['Green'] },
                index: 0,
                request,
                seen: ALL,
                typed: { a: 'Green' },
            }),
        ).toMatchObject({ primary: 'submit', canSubmit: true });
        // Whitespace is not an answer.
        expect(
            agentChatQuestionFooter({
                answers: {},
                index: 0,
                request,
                seen: ALL,
                typed: { a: '  ' },
            }).primary,
        ).toBeUndefined();
        // A free-text question has no option to tap.
        const freeText = ask(question('a', []));
        expect(
            agentChatQuestionFooter({
                answers: {},
                index: 0,
                request: freeText,
                seen: ALL,
                typed: {},
            }),
        ).toMatchObject({ primary: 'submit', canSubmit: false });
    });

    it('keeps Submit for one multiSelect question, since a tap only ticks an option', () => {
        const request = ask({ ...question('a', ['Red', 'Blue']), multiSelect: true });
        expect(
            agentChatQuestionFooter({ answers: {}, index: 0, request, seen: ALL, typed: {} }),
        ).toEqual({ isBackShown: false, primary: 'submit', canSubmit: false });
        expect(
            agentChatQuestionFooter({
                answers: { a: ['Red', 'Blue'] },
                index: 0,
                request,
                seen: ALL,
                typed: {},
            }),
        ).toMatchObject({ primary: 'submit', canSubmit: true });
    });

    it('steps through several questions with Back and Next, then Submit', () => {
        const request = ask(question('a', ['1']), question('b', ['2']), question('c', []));
        expect(
            agentChatQuestionFooter({ answers: {}, index: 0, request, seen: ALL, typed: {} }),
        ).toEqual({
            isBackShown: false,
            primary: 'next',
            canSubmit: false,
        });
        expect(
            agentChatQuestionFooter({
                answers: { a: ['1'] },
                index: 1,
                request,
                seen: ALL,
                typed: {},
            }),
        ).toEqual({ isBackShown: true, primary: 'next', canSubmit: true });
        expect(
            agentChatQuestionFooter({
                answers: { a: ['1'] },
                index: 2,
                request,
                seen: ALL,
                typed: {},
            }).primary,
        ).toBe('submit');
        // Every question answered: Submit is offered wherever the user is.
        expect(
            agentChatQuestionFooter({
                answers: { a: ['1'], b: ['2'], c: ['x'] },
                index: 0,
                request,
                seen: ALL,
                typed: {},
            }).primary,
        ).toBe('submit');
        // A recommended default on a question the user never opened is not an answer yet.
        expect(
            agentChatQuestionFooter({
                answers: { a: ['1'], b: ['2'], c: ['x'] },
                index: 0,
                request,
                seen: new Set([0]),
                typed: {},
            }).primary,
        ).toBe('next');
    });
});

describe('agentChatQuestionAdvance', () => {
    it('moves to the next unanswered question, wrapping, and sends when none is left', () => {
        const request = ask(question('a', ['1']), question('b', ['2']), question('c', ['3']));
        expect(agentChatQuestionAdvance(request, { a: ['1'] }, 0, ALL)).toEqual({
            kind: 'move',
            index: 1,
        });
        expect(agentChatQuestionAdvance(request, { b: ['2'], c: ['3'] }, 2, ALL)).toEqual({
            kind: 'move',
            index: 0,
        });
        expect(agentChatQuestionAdvance(request, { a: ['1'], b: ['2'], c: ['3'] }, 1, ALL)).toEqual(
            {
                kind: 'send',
            },
        );
    });

    it('opens an unseen question before sending, even when a default answers it', () => {
        const request = ask(question('a', ['1']), question('b', ['2 (Recommended)']));
        expect(
            agentChatQuestionAdvance(
                request,
                { a: ['1'], b: ['2 (Recommended)'] },
                0,
                new Set([0]),
            ),
        ).toEqual({
            kind: 'move',
            index: 1,
        });
    });
});
