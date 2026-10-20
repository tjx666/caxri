import { isAgentChatCaretKey } from './agent-chat-suggestions';

/**
 * The composer selection fields an automatic focus reads. A structural type keeps the logic testable without a DOM.
 */
interface ComposerSelection {
    selectionEnd: number;
    selectionStart: number;
    value: string;
}

/**
 * Composers whose selection the user placed (clicked, typed, or moved the caret with a key). Keyed by the input, so the
 * mark lives exactly as long as that composer: the editor keeps its selection across blur, so a caret the user put at
 * the start of the draft is still theirs when the Chat is shown again, while a remounted composer is a fresh editor
 * whose 0..0 selection is its initial value, not a user choice.
 *
 * This is deliberately separate from the caret `useAgentChatPlacedCaret` follows for the `@` Sessions list: that caret
 * is forgotten whenever the Chat is hidden, and it ignores modified caret keys such as Cmd+Up.
 */
const placedSelections = new WeakSet<ComposerSelection>();

/**
 * Records that the user placed the composer's selection, so automatic focus leaves it where it is.
 */
export function markAgentChatComposerSelectionPlaced(input: ComposerSelection): void {
    placedSelections.add(input);
}

/**
 * Records a key-down in the composer that may move its caret: any caret key, with or without modifiers (Cmd+Up,
 * Option+Left, Shift+End all place the selection).
 */
export function markAgentChatComposerCaretKey(
    input: ComposerSelection,
    event: { key: string },
): void {
    if (isAgentChatCaretKey({ key: event.key, altKey: false, ctrlKey: false, metaKey: false }))
        markAgentChatComposerSelectionPlaced(input);
}

/**
 * Where an automatic focus should put the caret, or `undefined` to keep the current selection. Only a non-empty draft
 * whose selection is still the untouched 0..0 a restored draft starts with moves to the end; a selection the user
 * placed, including a caret deliberately at the start, is kept.
 */
export function agentChatDraftEndCaret(input: ComposerSelection): number | undefined {
    const { length } = input.value;
    if (length === 0 || placedSelections.has(input)) return undefined;
    return input.selectionStart === 0 && input.selectionEnd === 0 ? length : undefined;
}
