import type { EditorNavigationTarget } from '@caxri/protocol';
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
type EditorRevealIntent =
    | { kind: 'match'; target: EditorRevealTarget }
    | { kind: 'navigation'; target: EditorNavigationTarget };

const pending = new Map<string, EditorRevealIntent>();

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

function applyNavigation(editor: MonacoEditor, target: EditorNavigationTarget): void {
    if (target.mode === 'caret') {
        editor.setSelection({
            startLineNumber: target.line,
            startColumn: target.column,
            endLineNumber: target.line,
            endColumn: target.column,
        });
        editor.revealLineInCenter(target.line);
        editor.focus();
        return;
    }
    const model = editor.getModel();
    const lineCount = model?.getLineCount() ?? target.endLine + 1;
    const startLine = Math.min(target.startLine, lineCount);
    const endLine = Math.min(target.endLine, lineCount);
    editor.setSelection({
        startLineNumber: startLine,
        startColumn: 1,
        endLineNumber: endLine,
        endColumn: model?.getLineMaxColumn(endLine) ?? 1,
    });
    editor.revealLineInCenter(startLine);
    editor.focus();
}

function applyIntent(editor: MonacoEditor, intent: EditorRevealIntent): void {
    if (intent.kind === 'match') applyReveal(editor, intent.target);
    else applyNavigation(editor, intent.target);
}

/**
 * Registers the live editor for one model and consumes any search reveal queued before mount.
 */
export function registerEditorRevealTarget(path: string, editor: MonacoEditor): () => void {
    editors.set(path, editor);
    const intent = pending.get(path);
    if (intent) {
        pending.delete(path);
        applyIntent(editor, intent);
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
    else pending.set(path, { kind: 'match', target });
}

/**
 * Queues a reveal without touching a still-registered editor that the current React commit is replacing.
 */
export function queueEditorNavigation(path: string, target: EditorNavigationTarget): void {
    pending.set(path, { kind: 'navigation', target });
}

/**
 * Applies an exact caret or inclusive whole-line selection to an already mounted Editor.
 */
export function revealEditorNavigation(path: string, target: EditorNavigationTarget): void {
    const editor = editors.get(path);
    if (editor) applyNavigation(editor, target);
    else queueEditorNavigation(path, target);
}
