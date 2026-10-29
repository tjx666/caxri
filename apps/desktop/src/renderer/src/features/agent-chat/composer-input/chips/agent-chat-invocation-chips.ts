import type { EditorState, Extension } from '@codemirror/state';
import { Facet, StateField } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

import { translate } from '../../../../i18n';
import { chipEditorFocus, chipFocusTracking, isChipFocusChange } from './agent-chat-chip-focus';
import type { AgentChatInvocationRange } from './agent-chat-invocation-range';
import { agentChatInvocationRange } from './agent-chat-invocation-range';
import { chipGlyph } from './agent-chat-session-chips';

/**
 * Lucide's `square-slash` and `package` shapes (as `<path>` data), the glyphs a sent message's invocation chip shows
 * for a command and a skill.
 */
const COMMAND_GLYPH_PATHS = [
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    'M9 15 15 9',
];
const SKILL_GLYPH_PATHS = [
    'M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z',
    'M12 22V12',
    'm3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7',
    'm7.5 4.27 9 5.15',
];

const NO_INVOCATIONS: ReadonlySet<string> = new Set();

/**
 * The invocations the composer menu offers right now (`/compact`, `$commit`), which decide what the leading token
 * recognizes as. Empty until the provider's commands and discovered skills arrive.
 */
export const agentChatKnownInvocations = Facet.define<ReadonlySet<string>, ReadonlySet<string>>({
    combine: (values) => values.at(-1) ?? NO_INVOCATIONS,
});

class InvocationChipWidget extends WidgetType {
    constructor(
        private readonly invocation: string,
        private readonly isSelected: boolean,
    ) {
        super();
    }

    override eq(other: InvocationChipWidget): boolean {
        return other.invocation === this.invocation && other.isSelected === this.isSelected;
    }

    override toDOM(view: EditorView): HTMLElement {
        const isSkill = this.invocation.startsWith('$');
        const name = this.invocation.slice(1);
        const chip = document.createElement('span');
        // Geometry is the Session chip's; `cm-invocation-chip` recolors it to the sent message's accent chip.
        chip.className = 'cm-session-chip cm-invocation-chip';
        if (this.isSelected) chip.classList.add('cm-session-chip-selected');
        chip.dataset.invocation = this.invocation;
        chip.setAttribute('role', 'img');
        chip.setAttribute(
            'aria-label',
            translate(
                isSkill
                    ? 'agentChat.composer.invocationChip.skill'
                    : 'agentChat.composer.invocationChip.command',
                { name },
            ),
        );
        const label = document.createElement('span');
        label.className = 'cm-session-chip-title';
        label.textContent = name;
        chip.append(chipGlyph(isSkill ? SKILL_GLYPH_PATHS : COMMAND_GLYPH_PATHS), label);
        // A click selects the whole chip, so Backspace then removes it; the caret never lands inside the token.
        chip.addEventListener('mousedown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            const range = recognizedRange(view.state);
            if (!range) return;
            view.focus();
            view.dispatch({ selection: { anchor: range.from, head: range.to } });
        });
        return chip;
    }
}

function recognizedRange(state: EditorState): AgentChatInvocationRange | undefined {
    const caret = state.field(chipEditorFocus) ? state.selection.main.head : undefined;
    return agentChatInvocationRange(
        state.sliceDoc(0, 256),
        state.facet(agentChatKnownInvocations),
        caret,
    );
}

function invocationChipDecorations(state: EditorState): DecorationSet {
    const range = recognizedRange(state);
    if (!range) return Decoration.none;
    const isSelected =
        state.field(chipEditorFocus) &&
        state.selection.ranges.some(
            (selected) => selected.from <= range.from && selected.to >= range.to,
        );
    return Decoration.set([
        Decoration.replace({
            widget: new InvocationChipWidget(range.invocation, isSelected),
        }).range(range.from, range.to),
    ]);
}

/**
 * The decorations live in a state field like the long-paste chips', so they never depend on view state.
 */
const invocationChipField = StateField.define<DecorationSet>({
    create: invocationChipDecorations,
    update(decorations, transaction) {
        return transaction.docChanged ||
            transaction.selection ||
            transaction.reconfigured ||
            isChipFocusChange(transaction)
            ? invocationChipDecorations(transaction.state)
            : decorations;
    },
    provide: (field) => [
        EditorView.decorations.from(field),
        EditorView.atomicRanges.of((view) => view.state.field(field)),
    ],
});

/**
 * Draws a recognized leading `/command` or `$skill` (`agentChatInvocationRange`) as the chip a sent message shows, so
 * the user sees before sending that the menu knows it. The document keeps the whole token, which is what the Agent
 * receives; the chip is atomic like the other composer chips (the caret steps over it, Backspace and Delete remove it
 * whole, a click selects it) and is read from the text, so a stashed draft, history recall, or Edit shows it too.
 */
export const agentChatInvocationChips: Extension = [chipFocusTracking, invocationChipField];
