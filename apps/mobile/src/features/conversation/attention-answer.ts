/**
 * A question's in-progress answer. Selected options and free text are tracked separately so a comma inside an option
 * label or a typed answer can never be mistaken for a delimiter; the two are only ever combined into one string at
 * submit time via {@link composeAttentionAnswer}.
 */
export interface AttentionAnswerDraft {
    freeText: string;
    selectedOptions: readonly string[];
}

export const emptyAttentionAnswerDraft = (): AttentionAnswerDraft => ({
    freeText: '',
    selectedOptions: [],
});

/**
 * Applies one option tap to the current selection. A single-select question replaces the whole selection; a
 * multi-select question toggles that one label in place.
 */
export const toggleAttentionOption = (
    current: readonly string[],
    label: string,
    isMultiSelect: boolean,
): string[] => {
    if (!isMultiSelect) return [label];
    return current.includes(label)
        ? current.filter((selected) => selected !== label)
        : [...current, label];
};

/**
 * Joins the selected options and any free text into the single answer string the Agent protocol expects, trimming free
 * text so whitespace-only entry does not count as an answer.
 */
export const composeAttentionAnswer = (
    selectedOptions: readonly string[],
    freeText: string,
): string => {
    const trimmedFreeText = freeText.trim();
    return [...selectedOptions, ...(trimmedFreeText ? [trimmedFreeText] : [])].join(', ');
};

export const isAttentionAnswerDraftEmpty = (draft: AttentionAnswerDraft): boolean =>
    composeAttentionAnswer(draft.selectedOptions, draft.freeText).length === 0;
