import type { ChangeSpec, TransactionSpec } from '@codemirror/state';
import { EditorSelection, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import type { AgentChatTextEdit } from './agent-chat-composer-list';

/**
 * The composer's message input as its hooks see it: the textarea members they used before the input became a CodeMirror
 * editor (`value`, the selection, `setSelectionRange`, `focus`), plus `applyEdit`, which changes the text as typing
 * would. The document is the draft's exact Markdown, so every offset means the same as it did in the textarea. One
 * object per composer, so a `WeakSet` keyed by it (`agent-chat-composer-caret.ts`) lives exactly as long as the
 * composer.
 */
export interface AgentChatComposerInput {
    applyEdit: (edit: AgentChatTextEdit) => void;
    /**
     * The editable element, for focus checks; `null` before the editor mounts.
     */
    readonly element: HTMLElement | null;
    focus: (options?: FocusOptions) => void;
    readonly selectionEnd: number;
    readonly selectionStart: number;
    setSelectionRange: (start: number, end: number) => void;
    readonly value: string;
}

/**
 * The `AgentChatComposerInput` for one composer, and `attach`, which points it at the composer's editor once it mounts
 * (`null` when it unmounts). Without an editor it reads as an empty textarea and ignores calls.
 */
export function agentChatComposerInput(): {
    attach: (editor: EditorView | null) => void;
    input: AgentChatComposerInput;
} {
    let view: EditorView | null = null;
    const clamp = (editor: EditorView, offset: number): number =>
        Math.max(0, Math.min(offset, editor.state.doc.length));
    const input: AgentChatComposerInput = {
        get element() {
            return view?.contentDOM ?? null;
        },
        get value() {
            return view?.state.doc.toString() ?? '';
        },
        get selectionStart() {
            return view?.state.selection.main.from ?? 0;
        },
        get selectionEnd() {
            return view?.state.selection.main.to ?? 0;
        },
        setSelectionRange: (start, end) =>
            view?.dispatch({
                selection: EditorSelection.single(clamp(view, start), clamp(view, end)),
                scrollIntoView: view.hasFocus,
            }),
        focus: (options) => view?.contentDOM.focus(options),
        applyEdit: (edit) =>
            view?.dispatch({
                changes: { from: edit.from, to: edit.to, insert: edit.text },
                selection: EditorSelection.cursor(edit.caret),
                scrollIntoView: true,
                userEvent: 'input',
            }),
    };
    return {
        attach: (editor) => {
            view = editor;
        },
        input,
    };
}

/**
 * A composer `keydown` as the key owners read it. It carries the textarea-era fields they use; `currentTarget` is the
 * editor's `AgentChatComposerInput`, so a handler reads the selection the key acts on.
 */
export interface AgentChatComposerKeyEvent {
    readonly altKey: boolean;
    readonly code: string;
    readonly ctrlKey: boolean;
    readonly currentTarget: AgentChatComposerInput;
    readonly defaultPrevented: boolean;
    readonly isComposing: boolean;
    readonly key: string;
    readonly keyCode: number;
    readonly metaKey: boolean;
    readonly nativeEvent: KeyboardEvent;
    preventDefault: () => void;
    readonly repeat: boolean;
    readonly shiftKey: boolean;
    stopPropagation: () => void;
}

export function agentChatComposerKeyEvent(
    event: KeyboardEvent,
    input: AgentChatComposerInput,
): AgentChatComposerKeyEvent {
    return {
        altKey: event.altKey,
        code: event.code,
        ctrlKey: event.ctrlKey,
        currentTarget: input,
        get defaultPrevented() {
            return event.defaultPrevented;
        },
        isComposing: event.isComposing,
        key: event.key,
        /* eslint-disable unicorn/prefer-keyboard-event-key -- `isImeComposing` reads 229 here (see `lib/ime.ts`) */
        // oxlint-disable-next-line typescript/no-deprecated -- same
        keyCode: event.keyCode,
        /* eslint-enable unicorn/prefer-keyboard-event-key */
        metaKey: event.metaKey,
        nativeEvent: event,
        preventDefault: event.preventDefault.bind(event),
        repeat: event.repeat,
        shiftKey: event.shiftKey,
        stopPropagation: event.stopPropagation.bind(event),
    };
}

/**
 * A composer `paste` as the paste owners read it; preventing it keeps the editor from inserting the clipboard text.
 */
export interface AgentChatComposerPasteEvent {
    readonly clipboardData: DataTransfer;
    readonly currentTarget: AgentChatComposerInput;
    readonly defaultPrevented: boolean;
    preventDefault: () => void;
}

export function agentChatComposerPasteEvent(
    event: ClipboardEvent,
    input: AgentChatComposerInput,
): AgentChatComposerPasteEvent | undefined {
    const { clipboardData } = event;
    if (!clipboardData) return undefined;
    return {
        clipboardData,
        currentTarget: input,
        get defaultPrevented() {
            return event.defaultPrevented;
        },
        preventDefault: event.preventDefault.bind(event),
    };
}

/**
 * The smallest change that turns `current` into `next`: the common prefix and suffix stay, so undo takes back only the
 * span that changed. `undefined` when they are equal.
 */
export function agentChatDraftChange(
    current: string,
    next: string,
): { from: number; insert: string; to: number } | undefined {
    if (current === next) return undefined;
    const limit = Math.min(current.length, next.length);
    let prefix = 0;
    while (prefix < limit && current[prefix] === next[prefix]) prefix += 1;
    let suffix = 0;
    while (
        suffix < limit - prefix &&
        current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
    )
        suffix += 1;
    return {
        from: prefix,
        insert: next.slice(prefix, next.length - suffix),
        to: current.length - suffix,
    };
}

/**
 * The transaction that brings the editor to a draft set from outside it (a sent message clearing it, Add to message, a
 * restored stash). The caret moves to the end, as a textarea's does when its value is set, so text added from another
 * surface is followed by the caret; a caller that wants it elsewhere (a picked mention) places it afterwards. A
 * replaced or cleared draft stays off the undo stack, so Cmd+Z cannot bring back a message that was sent; an insertion
 * into existing text, such as a picked mention, can be undone like typing.
 */
export function agentChatDraftTransaction(
    current: string,
    next: string,
): TransactionSpec | undefined {
    const change = agentChatDraftChange(current, next);
    if (!change) return undefined;
    const isReplaced = current === '' || next === '';
    const changes: ChangeSpec = change;
    return {
        changes,
        selection: EditorSelection.cursor(next.length),
        ...(isReplaced && { annotations: Transaction.addToHistory.of(false) }),
    };
}

/**
 * Trims a typed or pasted change so the document stays within `limit` characters, as a textarea's `maxLength` does;
 * `undefined` keeps the transaction as it is. A transaction with several changes past the limit is dropped (`[]`).
 */
export function agentChatLimitedChange(
    transaction: Transaction,
    limit: number,
): TransactionSpec | readonly [] | undefined {
    if (!transaction.docChanged || transaction.newDoc.length <= limit) return undefined;
    if (['input', 'paste', 'drop', 'move'].every((event) => !transaction.isUserEvent(event)))
        return undefined;
    const changes: Array<{ from: number; insert: string; to: number }> = [];
    transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) =>
        changes.push({ from, to, insert: inserted.toString() }),
    );
    if (changes.length !== 1) return [];
    const [change] = changes as [(typeof changes)[number]];
    const room = limit - (transaction.startState.doc.length - (change.to - change.from));
    if (room <= 0) return [];
    const insert = change.insert.slice(0, room);
    return {
        changes: { from: change.from, to: change.to, insert },
        selection: EditorSelection.cursor(change.from + insert.length),
        scrollIntoView: true,
        userEvent: transaction.annotation(Transaction.userEvent),
    };
}

/**
 * The message box's ARIA attributes as CodeMirror's content attributes take them: unset values left out, the rest as
 * strings.
 */
export function agentChatComposerAttributes(
    attributes: Record<string, boolean | number | string | undefined>,
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(attributes).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, String(value)]],
        ),
    );
}

/**
 * Whether a drag carries only text, which the editor inserts at the drop point as a textarea would. Files, Editor tabs,
 * and Projects are left to the pane's drop handlers, which cite them by path instead of pasting their contents.
 */
export function isAgentChatEditorTextDrop(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer || dataTransfer.files.length > 0) return false;
    return dataTransfer.types.every((type) => type.startsWith('text/'));
}
