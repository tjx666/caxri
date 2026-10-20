import { agentChatImageTokenRanges } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import { history, historyKeymap, insertNewline, standardKeymap } from '@codemirror/commands';
import type { Extension, Range } from '@codemirror/state';
import { Annotation, EditorState, Facet } from '@codemirror/state';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType } from '@codemirror/view';

import { resolveFileIcon } from '../../icons/files/file-icon-resolver';
import type { AgentChatMarkdownMark } from './agent-chat-composer-markdown';
import { agentChatMarkdownMarks } from './agent-chat-composer-markdown';
import { agentChatLimitedChange } from './agent-chat-composer-view';
import type { AgentChatPathPill } from './agent-chat-path-pills';
import { agentChatPathPillRanges } from './agent-chat-path-pills';

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

/**
 * One attached image as its placeholder pill shows it.
 */
export interface AgentChatComposerImagePill {
    label: string;
    thumbnail: string;
    token: number;
}

interface ImagePills {
    pills: ReadonlyMap<number, AgentChatComposerImagePill>;
    /**
     * Opens the image's preview when its pill is clicked.
     */
    open: (token: number) => void;
}

/**
 * The composer's attached images by placeholder number; a placeholder no image owns stays plain text.
 */
export const agentChatImagePills = Facet.define<ImagePills, ImagePills>({
    combine: (values) => values[0] ?? { pills: new Map(), open: () => {} },
});

class ImagePillWidget extends WidgetType {
    constructor(
        private readonly pill: AgentChatComposerImagePill,
        private readonly open: (token: number) => void,
    ) {
        super();
    }

    override eq(other: ImagePillWidget): boolean {
        return (
            other.pill.token === this.pill.token &&
            other.pill.label === this.pill.label &&
            other.pill.thumbnail === this.pill.thumbnail
        );
    }

    override toDOM(): HTMLElement {
        const pill = document.createElement('span');
        pill.className = 'cm-image-pill';
        pill.dataset.imageToken = String(this.pill.token);
        const thumbnail = document.createElement('img');
        thumbnail.alt = '';
        thumbnail.src = this.pill.thumbnail;
        pill.append(thumbnail, this.pill.label);
        // The press keeps the editor from moving the caret around the pill; the preview opens on the click, because a
        // dialog opened on the press would take the release and click on its overlay and close at once.
        pill.addEventListener('mousedown', (event) => {
            if (event.button === 0) event.preventDefault();
        });
        pill.addEventListener('click', (event) => {
            if (event.button === 0) this.open(this.pill.token);
        });
        return pill;
    }
}

function imagePillDecorations(state: EditorState): DecorationSet {
    const { open, pills } = state.facet(agentChatImagePills);
    if (pills.size === 0) return Decoration.none;
    return Decoration.set(
        agentChatImageTokenRanges(state.doc.toString()).flatMap(({ from, number, to }) => {
            const pill = pills.get(number);
            return pill
                ? [Decoration.replace({ widget: new ImagePillWidget(pill, open) }).range(from, to)]
                : [];
        }),
    );
}

/**
 * Draws each attached image's `[Image #N]` placeholder as a pill with its thumbnail, like a file pill in Cursor's
 * composer. The pill is atomic: the caret steps over it and Backspace deletes it whole, which removes the image
 * (`useAgentChatImagePlaceholders`). The document keeps the placeholder text, which is what the Agent receives.
 */
const imagePills = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = imagePillDecorations(view.state);
        }

        update(update: ViewUpdate): void {
            if (
                update.docChanged ||
                update.startState.facet(agentChatImagePills) !==
                    update.state.facet(agentChatImagePills)
            )
                this.decorations = imagePillDecorations(update.state);
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

/**
 * The paths dropped into this composer by their token; a token no drop wrote stays plain text, so a path the user types
 * never turns into a pill mid-word.
 */
export const agentChatPathPills = Facet.define<
    ReadonlyMap<string, AgentChatPathPill>,
    ReadonlyMap<string, AgentChatPathPill>
>({
    combine: (values) => values[0] ?? new Map(),
});

class PathPillWidget extends WidgetType {
    constructor(private readonly pill: AgentChatPathPill) {
        super();
    }

    override eq(other: PathPillWidget): boolean {
        return other.pill.token === this.pill.token && other.pill.kind === this.pill.kind;
    }

    override toDOM(): HTMLElement {
        const name = pathBasename(this.pill.path) || this.pill.path;
        const pill = document.createElement('span');
        pill.className = 'cm-path-pill';
        pill.dataset.pathPill = this.pill.path;
        pill.title = this.pill.path;
        const icon = document.createElement('img');
        icon.alt = '';
        icon.src = resolveFileIcon({ kind: this.pill.kind, name }).src;
        pill.append(icon, name);
        return pill;
    }
}

function pathPillDecorations(state: EditorState): DecorationSet {
    const pills = state.facet(agentChatPathPills);
    if (pills.size === 0) return Decoration.none;
    return Decoration.set(
        agentChatPathPillRanges(state.doc.toString(), pills).map(({ from, pill, to }) =>
            Decoration.replace({ widget: new PathPillWidget(pill) }).range(from, to),
        ),
    );
}

/**
 * Draws each dropped Files entry, Editor tab, or Project path as a pill with its file-type icon and name, the way
 * LobeHub's composer shows a dragged folder. Like an image pill it is atomic, and the document keeps the absolute path,
 * which is what the Agent receives; hovering the pill shows that path.
 */
const pathPills = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = pathPillDecorations(view.state);
        }

        update(update: ViewUpdate): void {
            if (
                update.docChanged ||
                update.startState.facet(agentChatPathPills) !==
                    update.state.facet(agentChatPathPills)
            )
                this.decorations = pathPillDecorations(update.state);
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
    '.cm-image-pill': {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '18px',
        margin: '0 1px',
        padding: '0 6px 0 2px',
        borderRadius: 'var(--radius-sm)',
        backgroundColor: CODE_BACKGROUND,
        fontSize: '12px',
        lineHeight: '18px',
        verticalAlign: 'text-bottom',
        cursor: 'zoom-in',
        userSelect: 'none',
    },
    '.cm-image-pill:hover': {
        backgroundColor: 'color-mix(in srgb, var(--border) 75%, transparent)',
    },
    '.cm-path-pill': {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '18px',
        margin: '0 1px',
        padding: '0 6px 0 3px',
        borderRadius: 'var(--radius-sm)',
        backgroundColor: CODE_BACKGROUND,
        fontSize: '12px',
        lineHeight: '18px',
        verticalAlign: 'text-bottom',
        userSelect: 'none',
    },
    '.cm-path-pill img': { width: '14px', height: '14px' },
    '.cm-image-pill img': {
        width: '14px',
        height: '14px',
        borderRadius: '3px',
        objectFit: 'cover',
    },
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
        imagePills,
        pathPills,
        composerTheme,
    ];
}
