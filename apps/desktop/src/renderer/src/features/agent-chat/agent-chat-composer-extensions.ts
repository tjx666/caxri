import { history, historyKeymap, insertNewline, standardKeymap } from '@codemirror/commands';
import type { Extension, Range } from '@codemirror/state';
import { Annotation, EditorState } from '@codemirror/state';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType } from '@codemirror/view';

import type { AgentChatMarkdownMark } from './agent-chat-composer-markdown';
import { agentChatMarkdownMarks } from './agent-chat-composer-markdown';
import { agentChatLimitedChange } from './agent-chat-composer-view';

/**
 * Marks a transaction that writes a draft set from outside the editor, so the change listener does not store it back.
 */
export const externalDraft = Annotation.define<boolean>();

class BulletWidget extends WidgetType {
    override eq(): boolean {
        return true;
    }

    override toDOM(): HTMLElement {
        const bullet = document.createElement('span');
        bullet.className = 'cm-md-bullet';
        bullet.textContent = '•';
        return bullet;
    }
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const hidden = Decoration.replace({});
const textStyles = {
    code: Decoration.mark({ class: 'cm-md-code' }),
    emphasis: Decoration.mark({ class: 'cm-md-emphasis' }),
    strike: Decoration.mark({ class: 'cm-md-strike' }),
    strong: Decoration.mark({ class: 'cm-md-strong' }),
    syntax: Decoration.mark({ class: 'cm-md-syntax' }),
};

function markDecoration(mark: AgentChatMarkdownMark): Range<Decoration> {
    switch (mark.kind) {
        case 'bullet': {
            return bullet.range(mark.from, mark.to);
        }
        case 'hide': {
            return hidden.range(mark.from, mark.to);
        }
        case 'text': {
            return textStyles[mark.style].range(mark.from, mark.to);
        }
        default: {
            // A wrapped list line continues under its text, not under the bullet.
            const indent = mark.indent
                ? {
                      style: `padding-left: calc(12px + ${mark.indent}ch); text-indent: -${mark.indent}ch`,
                  }
                : undefined;
            return Decoration.line({
                class: `cm-md-line-${mark.style}`,
                ...(indent && { attributes: indent }),
            }).range(mark.from);
        }
    }
}

function previewDecorations(view: EditorView): DecorationSet {
    const selection = view.hasFocus ? view.state.selection.ranges : [];
    const marks = agentChatMarkdownMarks(view.state.doc.toString(), selection);
    return Decoration.set(marks.map(markDecoration), true);
}

/**
 * Renders the draft's Markdown in place (`agentChatMarkdownMarks`); it re-reads the draft on every edit, caret move,
 * and focus change, which a message-sized document parses in well under a frame.
 */
const livePreview = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = previewDecorations(view);
        }

        update(update: ViewUpdate): void {
            if (update.docChanged || update.selectionSet || update.focusChanged)
                this.decorations = previewDecorations(update.view);
        }
    },
    { decorations: (plugin) => plugin.decorations },
);

const MONO = "var(--editor-font-family, ui-monospace, 'Caxri JetBrains Mono', monospace)";
const CODE_BACKGROUND = 'color-mix(in srgb, var(--border) 45%, transparent)';

/**
 * The textarea's look: three lines tall when empty, growing to `max-h-48` before it scrolls, in the Workbench's UI font
 * rather than CodeMirror's monospace default. Rendered Markdown uses the same tokens as the Chat's replies.
 */
const composerTheme = EditorView.theme({
    '&': { fontSize: '13px', color: 'inherit', backgroundColor: 'transparent' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'inherit', lineHeight: '20px', maxHeight: '12rem' },
    '.cm-content': { minHeight: '4.5rem', padding: '10px 0 4px', caretColor: 'var(--foreground)' },
    '.cm-line': { padding: '0 12px' },
    '.cm-placeholder': { color: 'var(--muted)' },
    '.cm-md-strong': { fontWeight: '600' },
    '.cm-md-emphasis': { fontStyle: 'italic' },
    '.cm-md-strike': { textDecoration: 'line-through' },
    '.cm-md-syntax': { color: 'var(--muted)' },
    '.cm-md-code': {
        fontFamily: MONO,
        fontSize: '12px',
        padding: '1px 0',
        borderRadius: 'var(--radius-sm)',
        backgroundColor: CODE_BACKGROUND,
    },
    '.cm-md-bullet': { color: 'var(--muted)', fontSize: '15px', lineHeight: '1' },
    '.cm-md-line-heading1': { fontSize: '17px', fontWeight: '600', lineHeight: '26px' },
    '.cm-md-line-heading2': { fontSize: '15px', fontWeight: '600', lineHeight: '24px' },
    '.cm-md-line-heading3': { fontWeight: '600' },
    '.cm-md-line-quote': {
        borderLeft: '3px solid var(--selection)',
        color: 'var(--muted)',
        marginLeft: '12px',
        paddingLeft: '9px',
    },
    '.cm-md-line-code, .cm-md-line-fence': {
        fontFamily: MONO,
        fontSize: '12px',
        backgroundColor: CODE_BACKGROUND,
    },
    '.cm-md-line-fence': { color: 'var(--muted)' },
});

/**
 * The editor setup every composer shares: undo history, the textarea's editing keys (Enter and Shift+Enter insert a
 * plain newline when no key owner took them), soft wrapping, the message length limit, and the live preview.
 */
export function agentChatComposerExtensions(maxLength: number): Extension {
    return [
        history(),
        keymap.of([
            { key: 'Enter', run: insertNewline, shift: insertNewline },
            ...historyKeymap,
            ...standardKeymap.filter((binding) => binding.key !== 'Enter'),
        ]),
        EditorView.lineWrapping,
        EditorState.transactionFilter.of(
            (transaction) => agentChatLimitedChange(transaction, maxLength) ?? transaction,
        ),
        livePreview,
        composerTheme,
    ];
}
