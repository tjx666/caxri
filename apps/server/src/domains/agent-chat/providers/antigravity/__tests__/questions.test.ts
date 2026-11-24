import { describe, expect, it } from 'vitest';

import {
    ANTIGRAVITY_QUESTION_CANCELLED,
    antigravityQuestionAnswers,
    mapAntigravityQuestion,
} from '../questions';

/**
 * The `requestedSchema` shape `agy` 1.5.16 sent for one single-choice and one multi-select `ask_question` call.
 */
const SCHEMA = {
    type: 'object',
    properties: {
        q1: {
            type: 'string',
            title: 'Which color do you prefer?',
            oneOf: [
                { const: '1', title: '(Recommended) Red' },
                { const: '2', title: 'Blue' },
            ],
        },
        q1_other: { type: 'string', title: 'Other', description: 'Optional free-form answer' },
        q2: {
            type: 'array',
            title: 'Which fruits do you like?',
            items: {
                anyOf: [
                    { const: '1', title: '(Recommended) Apple' },
                    { const: '2', title: 'Pear' },
                    { const: '3', title: 'Plum' },
                ],
            },
        },
        q2_other: { type: 'string', title: 'Other', description: 'Optional free-form answer' },
    },
};

describe('mapAntigravityQuestion', () => {
    it('reads each question with its choices and marks the recommended one the way the card expects', () => {
        expect(mapAntigravityQuestion('call_1', SCHEMA)).toEqual({
            id: 'call_1',
            kind: 'question',
            questions: [
                {
                    id: 'q1',
                    header: '',
                    question: 'Which color do you prefer?',
                    options: [
                        { label: 'Red (Recommended)', description: '' },
                        { label: 'Blue', description: '' },
                    ],
                    allowsOther: true,
                },
                {
                    id: 'q2',
                    header: '',
                    question: 'Which fruits do you like?',
                    options: [
                        { label: 'Apple (Recommended)', description: '' },
                        { label: 'Pear', description: '' },
                        { label: 'Plum', description: '' },
                    ],
                    allowsOther: true,
                    multiSelect: true,
                },
            ],
        });
    });

    it('lets a choice-free text question take typed text and skips fields it cannot show', () => {
        const mapped = mapAntigravityQuestion('call_2', {
            properties: {
                name: { type: 'string', title: 'Your name?' },
                count: { type: 'number', title: 'How many?' },
                broken: 'not a field',
                closed: { type: 'string', title: 'Pick', oneOf: [{ const: 'a', title: 'A' }] },
            },
        });
        expect(mapped.questions).toEqual([
            { id: 'name', header: '', question: 'Your name?', options: [], allowsOther: true },
            {
                id: 'closed',
                header: '',
                question: 'Pick',
                options: [{ label: 'A', description: '' }],
                allowsOther: false,
            },
        ]);
    });

    it('asks nothing for a schema without properties', () => {
        expect(mapAntigravityQuestion('call_3', undefined).questions).toEqual([]);
        expect(mapAntigravityQuestion('call_3', { properties: [] }).questions).toEqual([]);
    });
});

describe('antigravityQuestionAnswers', () => {
    it('sends chosen labels back as their consts', () => {
        expect(
            antigravityQuestionAnswers(SCHEMA, {
                q1: ['Blue'],
                q2: ['Apple (Recommended)', 'Plum'],
            }),
        ).toEqual({ action: 'accept', content: { q1: '2', q2: ['1', '3'] } });
    });

    it('puts typed text in the question’s free-text property', () => {
        expect(antigravityQuestionAnswers(SCHEMA, { q1: ['Green'], q2: ['Pear', 'Fig'] })).toEqual({
            action: 'accept',
            content: { q1_other: 'Green', q2: ['2'], q2_other: 'Fig' },
        });
    });

    it('answers a choice-free text question with the text itself', () => {
        expect(
            antigravityQuestionAnswers(
                { properties: { name: { type: 'string', title: 'Your name?' } } },
                { name: ['Ada'] },
            ),
        ).toEqual({ action: 'accept', content: { name: 'Ada' } });
    });

    it('cancels when nothing was answered, and ignores answers to questions the form does not ask', () => {
        expect(antigravityQuestionAnswers(SCHEMA, {})).toBe(ANTIGRAVITY_QUESTION_CANCELLED);
        expect(antigravityQuestionAnswers(SCHEMA, { q9: ['Red'], q1: ['  '] })).toBe(
            ANTIGRAVITY_QUESTION_CANCELLED,
        );
    });
});
