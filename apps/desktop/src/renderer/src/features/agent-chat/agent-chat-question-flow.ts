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
