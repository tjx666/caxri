import type { AgentChatRequest } from '@caxri/protocol';
import { MAX_AGENT_CHAT_QUESTIONS } from '@caxri/protocol';

import { clip, isRecord, stringField } from '../../chat-items';
import type { AcpQuestionDialect } from '../acp/requests';

/**
 * Antigravity's questions: `agy acp` sends its `ask_question` tool as an ACP form elicitation (`elicitation/create`
 * with `mode: 'form'`) once `initialize` advertised `elicitation.form`, and without that capability never asks the
 * client at all. Its `requestedSchema` holds one property per question (`q1`, `q2`, ...): a `string` with `oneOf`
 * choices for a single answer, or an `array` whose `items.anyOf` lists the choices of a multi-select one, each choice a
 * `{ const, title }`, plus an optional free-text `q1_other`. The recommended choice's title starts with `(Recommended)
 * `. The answer is `{ action: 'accept', content }` keyed the same way. Verified against `agy` 1.5.16.
 *
 * @see https://agentclientprotocol.com/rfds/elicitation
 */

type Json = Record<string, unknown>;

interface FormChoice {
    /**
     * The `const` the answer carries back, kept as `agy` sent it.
     */
    value: unknown;
    label: string;
}

interface FormQuestion {
    key: string;
    text: string;
    multiSelect: boolean;
    choices: FormChoice[];
    /**
     * The free-text property that takes an answer no choice covers, when the form has one.
     */
    otherKey?: string;
}

const RECOMMENDED_PREFIX = /^\s*\(recommended\)\s*/iu;

/**
 * A choice's title as the question card reads it: `agy` marks the recommended one with a leading `(Recommended) `, and
 * the card recognizes the trailing form, which also preselects it.
 */
function choiceLabel(title: string): string {
    const text = title.replace(RECOMMENDED_PREFIX, '');
    return clip(text === title || !text ? title : `${text} (Recommended)`, 200);
}

function formChoices(list: unknown): FormChoice[] {
    const entries: unknown[] = Array.isArray(list) ? list : [];
    return entries.slice(0, 20).flatMap((entry) => {
        if (!isRecord(entry) || !Object.hasOwn(entry, 'const')) return [];
        const title = stringField(entry.title) ?? String(entry.const);
        return title ? [{ value: entry.const, label: choiceLabel(title) }] : [];
    });
}

/**
 * The questions a form's `requestedSchema` asks, in property order. A `<key>_other` property belongs to the question
 * `<key>` rather than asking one of its own; a property that is neither a choice nor free text is skipped.
 */
function formQuestions(schema: unknown): FormQuestion[] {
    const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
    const questions: FormQuestion[] = [];
    for (const [key, field] of Object.entries(properties)) {
        if (questions.length >= MAX_AGENT_CHAT_QUESTIONS) break;
        if (!isRecord(field)) continue;
        if (key.endsWith('_other') && isRecord(properties[key.slice(0, -'_other'.length)]))
            continue;
        const items = isRecord(field.items) ? field.items : undefined;
        const isMultiSelect = field.type === 'array';
        const choices = formChoices(
            isMultiSelect
                ? (items?.anyOf ?? items?.oneOf ?? items?.enum)
                : (field.oneOf ?? field.anyOf),
        );
        if (field.type !== 'string' && choices.length === 0) continue;
        const other = properties[`${key}_other`];
        questions.push({
            key,
            text: clip(stringField(field.title) ?? stringField(field.description) ?? key, 2_000),
            multiSelect: isMultiSelect,
            choices,
            ...(isRecord(other) && other.type === 'string' && { otherKey: `${key}_other` }),
        });
    }
    return questions;
}

/**
 * An `elicitation/create` form's `requestedSchema` as a question card keyed by the `ask_question` tool call. A question
 * with no free-text property accepts only its choices, except a `string` question without choices, which the user
 * answers in text.
 */
export function mapAntigravityQuestion(
    id: string,
    schema: unknown,
): Extract<AgentChatRequest, { kind: 'question' }> {
    return {
        id,
        kind: 'question',
        questions: formQuestions(schema).map((question) => ({
            id: question.key,
            header: '',
            question: question.text,
            options: question.choices.map(({ label }) => ({ label, description: '' })),
            allowsOther: question.otherKey !== undefined || question.choices.length === 0,
            ...(question.multiSelect && { multiSelect: true }),
        })),
    };
}

export const ANTIGRAVITY_QUESTION_CANCELLED = { action: 'cancel' };

/**
 * The elicitation response for the card's answers, which are option labels or typed text per question id. A label goes
 * back as its choice's `const`; typed text goes to the question's free-text property, or is the answer itself for a
 * `string` question without choices. No answer at all cancels, so the turn goes on without the user's choice.
 */
export function antigravityQuestionAnswers(
    schema: unknown,
    answers: Readonly<Record<string, readonly string[]>>,
): Json {
    const content: Json = {};
    for (const question of formQuestions(schema)) {
        const given = Object.hasOwn(answers, question.key) ? answers[question.key] : [];
        const values: unknown[] = [];
        const typed: string[] = [];
        for (const answer of given) {
            const choice = question.choices.find(({ label }) => label === answer);
            if (choice) values.push(choice.value);
            else if (answer.trim()) typed.push(answer.trim());
        }
        if (question.multiSelect) {
            if (values.length > 0) content[question.key] = values;
        } else if (values.length > 0) content[question.key] = values[0];
        if (typed.length === 0) continue;
        if (question.otherKey) content[question.otherKey] = typed.join(', ');
        else if (question.choices.length === 0) content[question.key] = typed.join(', ');
    }
    return Object.keys(content).length > 0
        ? { action: 'accept', content }
        : ANTIGRAVITY_QUESTION_CANCELLED;
}

export const antigravityQuestions: AcpQuestionDialect = {
    request: mapAntigravityQuestion,
    answers: antigravityQuestionAnswers,
    cancelled: ANTIGRAVITY_QUESTION_CANCELLED,
};
