import type { Extension } from '@codemirror/state';
import { StateEffect, StateField } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const focusChanged = StateEffect.define<boolean>();

/**
 * Whether the editor has focus, so a chip shows its selection outline only while the caret is live. A state field
 * cannot ask the view, so focus changes arrive as an effect.
 */
export const chipEditorFocus = StateField.define<boolean>({
    create: () => false,
    update(isFocused, transaction) {
        for (const effect of transaction.effects) if (effect.is(focusChanged)) return effect.value;
        return isFocused;
    },
});

/**
 * Tracks focus for the chip state fields. Every chip extension that reads `chipEditorFocus` includes this same
 * instance, which CodeMirror deduplicates.
 */
export const chipFocusTracking: Extension = [
    chipEditorFocus,
    EditorView.focusChangeEffect.of((_state, isFocusing) => focusChanged.of(isFocusing)),
];

/**
 * Whether a transaction changed the focus a chip field depends on.
 */
export function isChipFocusChange(transaction: {
    effects: ReadonlyArray<StateEffect<unknown>>;
}): boolean {
    return transaction.effects.some((effect) => effect.is(focusChanged));
}
