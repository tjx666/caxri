import type { Extension } from '@codemirror/state';
import { StateEffect, StateField } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

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
 * Corrects `chipEditorFocus` when it disagrees with the view. CodeMirror sends its focus transaction from a microtask
 * and drops it when another dispatch changed the state first (`EditorView.update` requires `state ==
 * dispatchFocus.startState`), while still recording the focus as notified. On a slow Renderer the composer's own draft
 * and compartment dispatches landed first, so the field stayed unfocused and a `/command` still being typed showed as a
 * chip.
 */
const chipFocusReconciler = ViewPlugin.define((view) => {
    let isScheduled = false;
    let isDestroyed = false;
    return {
        update() {
            if (isScheduled) return;
            isScheduled = true;
            queueMicrotask(() => {
                isScheduled = false;
                if (isDestroyed) return;
                const isFocused = view.hasFocus;
                if (view.state.field(chipEditorFocus) !== isFocused) {
                    view.dispatch({ effects: focusChanged.of(isFocused) });
                }
            });
        },
        destroy() {
            isDestroyed = true;
        },
    };
});

/**
 * Tracks focus for the chip state fields. Every chip extension that reads `chipEditorFocus` includes this same
 * instance, which CodeMirror deduplicates.
 */
export const chipFocusTracking: Extension = [
    chipEditorFocus,
    EditorView.focusChangeEffect.of((_state, isFocusing) => focusChanged.of(isFocusing)),
    chipFocusReconciler,
];

/**
 * Whether a transaction changed the focus a chip field depends on.
 */
export function isChipFocusChange(transaction: {
    effects: ReadonlyArray<StateEffect<unknown>>;
}): boolean {
    return transaction.effects.some((effect) => effect.is(focusChanged));
}
