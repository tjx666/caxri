import type { AgentChatRequest, AgentChatResponse } from '@caxri/protocol';
import { agentChatQuestionOption } from '@caxri/protocol';

type QuestionRequest = Extract<AgentChatRequest, { kind: 'question' }>;
type QuestionOption = QuestionRequest['questions'][number]['options'][number];

/**
 * The option a question starts with selected: the provider's recommendation, so one Submit (or Enter) accepts it.
 * Without a recommendation nothing is preselected, because preselecting an arbitrary first option would read as advice
 * the provider never gave.
 */
export function recommendedQuestionOptionIndex(
    options: readonly QuestionOption[],
): number | undefined {
    const index = options.findIndex(
        (option) => agentChatQuestionOption(option.label).isRecommended,
    );
    return index === -1 ? undefined : index;
}

/**
 * The option a digit key picks: `1` is the first option, up to `9`. Anything else, or a digit past the last option,
 * picks nothing.
 */
export function questionOptionIndexForKey(key: string, optionCount: number): number | undefined {
    if (!/^[1-9]$/.test(key)) return undefined;
    const index = Number(key) - 1;
    return index < optionCount ? index : undefined;
}

export type AgentChatQuestionStep =
    | { kind: 'next'; answers: Record<string, string[]>; index: number }
    | { kind: 'respond'; response: AgentChatResponse };

/**
 * Records the answer to the question at `index` and says what the card does next. Questions are asked one at a time, as
 * Codex does: answering moves to the next question, and the last one sends every answer collected so far. A blank
 * `answer` skips the question, leaving it out for the provider to treat as unanswered; skipping every question cancels
 * the request rather than sending an empty answer set.
 */
export function answerAgentChatQuestion(
    request: QuestionRequest,
    answers: Readonly<Record<string, string[]>>,
    index: number,
    answer: string | undefined,
): AgentChatQuestionStep {
    const question = request.questions.at(index);
    const next: Record<string, string[]> = { ...answers };
    const typed = answer?.trim();
    if (question) {
        if (typed) next[question.id] = [typed];
        else delete next[question.id];
    }
    if (index + 1 < request.questions.length)
        return { kind: 'next', answers: next, index: index + 1 };
    return Object.keys(next).length === 0
        ? { kind: 'respond', response: { kind: 'decision', decision: 'cancel' } }
        : { kind: 'respond', response: { kind: 'answers', answers: next } };
}
