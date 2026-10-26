import type { AgentChatSessionReferenceRange } from '@caxri/protocol';
import { agentChatSessionReferenceRanges } from '@caxri/protocol';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';

import { translate } from '../../../i18n';
import { sessionReferenceProjectTitle } from '../../session/session-reference';

/**
 * Lucide's `message-circle` path, the glyph the `@` list shows beside a Session. A CodeMirror widget builds plain DOM,
 * so it draws the path itself rather than mounting the React icon.
 */
const SESSION_GLYPH_PATH =
    'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function sessionGlyph(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', SESSION_GLYPH_PATH);
    svg.append(path);
    return svg;
}

class SessionChipWidget extends WidgetType {
    constructor(
        private readonly reference: AgentChatSessionReferenceRange,
        private readonly isSelected: boolean,
    ) {
        super();
    }

    override eq(other: SessionChipWidget): boolean {
        return (
            other.reference.path === this.reference.path &&
            other.reference.title === this.reference.title &&
            other.isSelected === this.isSelected
        );
    }

    override toDOM(view: EditorView): HTMLElement {
        const { path, title } = this.reference;
        const chip = document.createElement('span');
        chip.className = 'cm-session-chip';
        if (this.isSelected) chip.classList.add('cm-session-chip-selected');
        chip.dataset.sessionReference = title;
        chip.setAttribute('role', 'img');
        chip.setAttribute('aria-label', translate('agentChat.sessionReference.label', { title }));
        const project = sessionReferenceProjectTitle(path);
        chip.title = project
            ? translate('agentChat.sessionReference.inProject', { project, title })
            : title;
        const name = document.createElement('span');
        name.className = 'cm-session-chip-title';
        name.textContent = title;
        chip.append(sessionGlyph(), '@', name);
        // A click selects the whole chip, so Backspace then removes it; the caret never lands inside the reference text.
        chip.addEventListener('mousedown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            const from = view.posAtDOM(chip);
            const range = agentChatSessionReferenceRanges(view.state.doc.toString()).find(
                (candidate) => candidate.from === from,
            );
            if (!range) return;
            view.focus();
            view.dispatch({ selection: { anchor: range.from, head: range.to } });
        });
        return chip;
    }
}

function sessionChipDecorations(view: EditorView): DecorationSet {
    const { selection } = view.state;
    return Decoration.set(
        agentChatSessionReferenceRanges(view.state.doc.toString()).map((reference) => {
            const isSelected =
                view.hasFocus &&
                selection.ranges.some(
                    (range) => range.from <= reference.from && range.to >= reference.to,
                );
            return Decoration.replace({
                widget: new SessionChipWidget(reference, isSelected),
            }).range(reference.from, reference.to);
        }),
    );
}

/**
 * Draws each cited Session (`formatAgentChatSessionReference`) as a chip with the Session glyph, `@`, and its title, as
 * the `@` list showed it. The document keeps the whole reference sentence, which is what the Agent receives, but the
 * chip is atomic like an image pill: the caret steps over it, Backspace and Delete remove it whole, and a click selects
 * it. The chip is read from the text rather than recorded when chosen, so a draft restored from a stash, a Session
 * switch, a restart, prompt history, the queue, or Edit from here shows the same chip.
 */
export const agentChatSessionChips = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = sessionChipDecorations(view);
        }

        update(update: ViewUpdate): void {
            if (update.docChanged || update.selectionSet || update.focusChanged)
                this.decorations = sessionChipDecorations(update.view);
        }
    },
    {
        decorations: (plugin) => plugin.decorations,
        provide: (plugin) =>
            EditorView.atomicRanges.of(
                (view) => view.plugin(plugin)?.decorations ?? Decoration.none,
            ),
    },
);
