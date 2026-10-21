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
 * What the question card's primary button does. `next` moves to a question the user has not opened yet; `submit` sends
 * the answers. Submitting from the first tab used to record every unopened question as skipped, or accept its
 * recommended default, although the user never saw it, so Submit waits until each question has been opened at least
 * once. An unanswered question the user opened and left is a deliberate skip, and Skip (Esc) still dismisses the whole
 * form at any point.
 */
export type QuestionFormPrimaryAction = { kind: 'next'; index: number } | { kind: 'submit' };

/**
 * Picks the primary action for the question at `index` of `count`: the next unseen question after it (wrapping), or
 * Submit when every question has been opened.
 */
export function questionFormPrimaryAction(
    count: number,
    index: number,
    seen: ReadonlySet<number>,
): QuestionFormPrimaryAction {
    for (let step = 1; step < count; step += 1) {
        const candidate = (index + step) % count;
        if (!seen.has(candidate)) return { kind: 'next', index: candidate };
    }
    return { kind: 'submit' };
}

/**
 * The card's muted title line and the header shown above the question itself. Several questions keep each header with
 * its own question behind the tabs; a lone question's header joins the title line, so the card opens on one muted line
 * rather than two, as the Codex app sets a question.
 */
export function questionCardHeadings(
    title: string,
    questionCount: number,
    header: string | undefined,
): { title: string; questionHeader: string | undefined } {
    if (!header) return { title, questionHeader: undefined };
    return questionCount > 1
        ? { title, questionHeader: header }
        : { title: `${title} · ${header}`, questionHeader: undefined };
}

/**
 * What a key pressed in a question's panel does: `pick` the option a digit names (tick it on a `multiSelect` question,
 * answer with it otherwise), `typed` for the digit just past the last option (the free-text row), `move` to the row an
 * arrow reaches, or `advance` on Enter in a `multiSelect` question, whose rows are checkboxes rather than answers.
 * `cursor` is the selected option of a single-choice question or the focused row of a `multiSelect` one. A key with a
 * modifier, or one typed in the free-text input, does nothing here.
 */
export type QuestionPanelKeyAction =
    | { kind: 'advance' }
    | { kind: 'move'; index: number }
    | { kind: 'pick'; index: number }
    | { kind: 'typed' };

export function questionPanelKeyAction(
    key: string,
    {
        cursor,
        isIgnored,
        isMulti,
        optionCount,
    }: { cursor: number; isIgnored: boolean; isMulti: boolean; optionCount: number },
): QuestionPanelKeyAction | undefined {
    if (isIgnored) return undefined;
    if (isMulti && key === 'Enter') return { kind: 'advance' };
    const picked = questionOptionIndexForKey(key, optionCount + 1);
    if (picked !== undefined)
        return picked < optionCount ? { kind: 'pick', index: picked } : { kind: 'typed' };
    const next = questionOptionIndexForArrow(key, cursor, optionCount);
    return next === undefined ? undefined : { kind: 'move', index: next };
}
