import type { AgentChatResponse } from '@caxri/protocol';

/**
 * The option a digit key picks: `1` is the first option, up to `9`. Anything else, or a digit past the last option,
 * picks nothing.
 */
export function questionOptionIndexForKey(key: string, optionCount: number): number | undefined {
    if (!/^[1-9]$/.test(key)) return undefined;
    const index = Number(key) - 1;
    return index < optionCount ? index : undefined;
}

/**
 * The option ArrowDown or ArrowUp selects, wrapping at either end. With nothing selected, ArrowDown starts at the first
 * option and ArrowUp at the last. Any other key, or a question without options, selects nothing.
 */
export function questionOptionIndexForArrow(
    key: string,
    selectedIndex: number,
    optionCount: number,
): number | undefined {
    if (optionCount === 0 || (key !== 'ArrowDown' && key !== 'ArrowUp')) return undefined;
    const step = key === 'ArrowDown' ? 1 : -1;
    if (selectedIndex === -1) return step === 1 ? 0 : optionCount - 1;
    return (selectedIndex + step + optionCount) % optionCount;
}

/**
 * The response a question card sends: every answered question, with unanswered ones left out for the provider to treat
 * as skipped. Sending with nothing answered cancels the request rather than sending an empty answer set.
 */
export function agentChatQuestionResponse(
    answers: Readonly<Record<string, string[]>>,
): AgentChatResponse {
    return Object.keys(answers).length === 0
        ? { kind: 'decision', decision: 'cancel' }
        : { kind: 'answers', answers: { ...answers } };
}

/**
 * What the question card's primary button does. `next` moves to a question the user has neither answered nor opened
 * yet; `submit` sends the answers. Submitting from the first tab used to record every unopened question as skipped
 * although the user never saw it, so Submit waits until each unanswered question has been opened at least once. An
 * unanswered question the user opened and left is a deliberate skip, and Skip (Esc) still dismisses the whole form at
 * any point.
 */
export type QuestionFormPrimaryAction = { kind: 'next'; index: number } | { kind: 'submit' };

/**
 * Picks the primary action for the question at `index`: the next unanswered, unseen question after it (wrapping), or
 * Submit when no such question remains.
 */
export function questionFormPrimaryAction(
    questionIds: readonly string[],
    answers: Readonly<Record<string, readonly string[]>>,
    index: number,
    seen: ReadonlySet<number>,
): QuestionFormPrimaryAction {
    const count = questionIds.length;
    for (let step = 1; step < count; step += 1) {
        const candidate = (index + step) % count;
        if (!Object.hasOwn(answers, questionIds[candidate]) && !seen.has(candidate)) {
            return { kind: 'next', index: candidate };
        }
    }
    return { kind: 'submit' };
}
