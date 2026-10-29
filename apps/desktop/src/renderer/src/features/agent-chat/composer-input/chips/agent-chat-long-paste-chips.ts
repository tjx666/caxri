import type { LongPasteReferenceRange } from '@caxri/protocol';
import { longPasteReferenceRanges } from '@caxri/protocol';
import type { EditorState, Extension } from '@codemirror/state';
import { StateField } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

import { agentChatLongPasteChipText } from '../agent-chat-long-paste';
import { chipEditorFocus, chipFocusTracking, isChipFocusChange } from './agent-chat-chip-focus';
import { chipGlyph } from './agent-chat-session-chips';

/**
 * Lucide's `file-text` paths, the document glyph a saved paste's chip shows.
 */
const PASTE_GLYPH_PATHS = [
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z',
    'M14 2v4a2 2 0 0 0 2 2h4',
    'M10 9H8',
    'M16 13H8',
    'M16 17H8',
];

class LongPasteChipWidget extends WidgetType {
    constructor(
        private readonly reference: LongPasteReferenceRange,
        private readonly isSelected: boolean,
    ) {
        super();
    }

    override eq(other: LongPasteChipWidget): boolean {
        return (
            other.reference.path === this.reference.path &&
            other.reference.lineCount === this.reference.lineCount &&
            other.reference.characterCount === this.reference.characterCount &&
            other.isSelected === this.isSelected
        );
    }

    override toDOM(view: EditorView): HTMLElement {
        const { aria, detail, label } = agentChatLongPasteChipText(this.reference, false);
        const chip = document.createElement('span');
        // Shares the Session chip's look: both are references the Agent receives as text but a person reads as a name.
        chip.className = 'cm-session-chip cm-long-paste-chip';
        if (this.isSelected) chip.classList.add('cm-session-chip-selected');
        chip.dataset.longPasteReference = this.reference.path;
        chip.setAttribute('role', 'img');
        chip.setAttribute('aria-label', aria);
        chip.title = detail;
        const name = document.createElement('span');
        name.className = 'cm-session-chip-title';
        name.textContent = label;
        chip.append(chipGlyph(PASTE_GLYPH_PATHS), name);
        // A click selects the whole chip, so Backspace then removes it; the caret never lands inside the note.
        chip.addEventListener('mousedown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            const from = view.posAtDOM(chip);
            const range = longPasteReferenceRanges(view.state.doc.toString()).find(
                (candidate) => candidate.from === from,
            );
            if (!range) return;
            view.focus();
            view.dispatch({ selection: { anchor: range.from, head: range.to } });
        });
        return chip;
    }
}

function longPasteChipDecorations(state: EditorState): DecorationSet {
    const isFocused = state.field(chipEditorFocus);
    return Decoration.set(
        longPasteReferenceRanges(state.doc.toString()).map((reference) => {
            const isSelected =
                isFocused &&
                state.selection.ranges.some(
                    (range) => range.from <= reference.from && range.to >= reference.to,
                );
            return Decoration.replace({
                widget: new LongPasteChipWidget(reference, isSelected),
            }).range(reference.from, reference.to);
        }),
    );
}

/**
 * The decorations live in a state field, not a view plugin: the note spans several lines, and CodeMirror rejects a
 * plugin's decoration that replaces a line break.
 */
const longPasteChipField = StateField.define<DecorationSet>({
    create: longPasteChipDecorations,
    update(decorations, transaction) {
        return transaction.docChanged || transaction.selection || isChipFocusChange(transaction)
            ? longPasteChipDecorations(transaction.state)
            : decorations;
    },
    provide: (field) => [
        EditorView.decorations.from(field),
        EditorView.atomicRanges.of((view) => view.state.field(field)),
    ],
});

/**
 * Draws each saved long paste (`formatLongPasteReference`) as a `Pasted text · N lines` chip instead of the multi-line
 * note. The document keeps the whole note, which is what the Agent receives, but the chip is atomic like a Session
 * chip: the caret steps over it, Backspace and Delete remove it whole, and a click selects it. It is read from the
 * text, so a stashed draft, a restart, prompt history, the queue, or Edit shows the same chip.
 */
export const agentChatLongPasteChips: Extension = [chipFocusTracking, longPasteChipField];
