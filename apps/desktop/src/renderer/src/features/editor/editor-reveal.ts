import type { OnMount } from '@monaco-editor/react';

type MonacoEditor = Parameters<OnMount>[0];

export interface EditorRevealTarget {
    line: number;
    column: number;
    matchLength: number;
    /**
     * Search results select their match; navigation-only reveals leave a caret at the location.
     */
    select?: boolean;
}

const editors = new Map<string, MonacoEditor>();
const pending = new Map<string, EditorRevealTarget>();

function applyReveal(editor: MonacoEditor, target: EditorRevealTarget): void {
    const endColumn =
        target.column + (target.select === false ? 0 : Math.max(1, target.matchLength));
    editor.setSelection({
        startLineNumber: target.line,
        startColumn: target.column,
        endLineNumber: target.line,
        endColumn,
    });
    editor.revealLineInCenter(target.line);
    editor.focus();
}

/**
 * Registers the live editor for one model and consumes any search reveal queued before mount.
 */
export function registerEditorRevealTarget(path: string, editor: MonacoEditor): () => void {
    editors.set(path, editor);
    const target = pending.get(path);
    if (target) {
        pending.delete(path);
        applyReveal(editor, target);
    }
    return () => {
        if (editors.get(path) === editor) editors.delete(path);
    };
}

/**
 * Reveals immediately when the model is mounted, otherwise queues one latest intent for mount.
 */
export function revealEditorMatch(path: string, target: EditorRevealTarget): void {
    const editor = editors.get(path);
    if (editor) applyReveal(editor, target);
    else pending.set(path, target);
}

/**
 * Queues a reveal without touching a still-registered editor that the current React commit is replacing.
 */
export function queueEditorRevealLocation(
    path: string,
    target: Pick<EditorRevealTarget, 'column' | 'line'>,
): void {
    pending.set(path, { ...target, matchLength: 0, select: false });
}

/**
 * Navigates to a source location without selecting the character after the requested column.
 */
export function revealEditorLocation(
    path: string,
    target: Pick<EditorRevealTarget, 'column' | 'line'>,
): void {
    revealEditorMatch(path, { ...target, matchLength: 0, select: false });
}
