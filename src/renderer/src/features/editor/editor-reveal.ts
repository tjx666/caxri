import type { OnMount } from '@monaco-editor/react';

type MonacoEditor = Parameters<OnMount>[0];

export interface EditorRevealTarget {
    line: number;
    column: number;
    matchLength: number;
}

const editors = new Map<string, MonacoEditor>();
const pending = new Map<string, EditorRevealTarget>();

function applyReveal(editor: MonacoEditor, target: EditorRevealTarget): void {
    const endColumn = target.column + Math.max(1, target.matchLength);
    editor.setSelection({
        startLineNumber: target.line,
        startColumn: target.column,
        endLineNumber: target.line,
        endColumn,
    });
    editor.revealLineInCenter(target.line);
    editor.focus();
}

/** Registers the live editor for one model and consumes any search reveal queued before mount. */
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

/** Reveals immediately when the model is mounted, otherwise queues one latest intent for mount. */
export function revealEditorMatch(path: string, target: EditorRevealTarget): void {
    const editor = editors.get(path);
    if (editor) applyReveal(editor, target);
    else pending.set(path, target);
}
