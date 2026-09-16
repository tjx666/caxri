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

const defaultEditorInstance = Symbol('default-editor-instance');
type EditorInstanceKey = string | typeof defaultEditorInstance;

const editors = new Map<string, Map<EditorInstanceKey, MonacoEditor>>();
type EditorRevealIntent =
    | { kind: 'focus' }
    | { kind: 'match'; target: EditorRevealTarget }
    | { kind: 'navigation'; target: EditorNavigationTarget };

const pending = new Map<string, EditorRevealIntent>();
const pendingByInstance = new Map<string, EditorRevealIntent>();

function pendingInstanceKey(path: string, instanceId: string): string {
    return JSON.stringify([path, instanceId]);
}

function registeredEditor(path: string, instanceId?: string): MonacoEditor | undefined {
    const registrations = editors.get(path);
    if (!registrations) return undefined;
    if (instanceId) return registrations.get(instanceId);
    let latest: MonacoEditor | undefined;
    for (const editor of registrations.values()) latest = editor;
    return latest;
}

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
    if (intent.kind === 'focus') editor.focus();
    else if (intent.kind === 'match') applyReveal(editor, intent.target);
    else applyNavigation(editor, intent.target);
}

/**
 * Registers one live Editor occurrence for a model. `instanceId` preserves independent split-pane focus while
 * model-only navigation keeps its established latest-mounted fallback.
 */
export function registerEditorRevealTarget(
    path: string,
    editor: MonacoEditor,
    instanceId?: string,
): () => void {
    const registrations = editors.get(path) ?? new Map<EditorInstanceKey, MonacoEditor>();
    const registrationKey = instanceId ?? defaultEditorInstance;
    registrations.set(registrationKey, editor);
    editors.set(path, registrations);
    const generalIntent = pending.get(path);
    if (generalIntent) {
        pending.delete(path);
        applyIntent(editor, generalIntent);
    }
    const instanceIntent = instanceId
        ? pendingByInstance.get(pendingInstanceKey(path, instanceId))
        : undefined;
    if (instanceId && instanceIntent) {
        pendingByInstance.delete(pendingInstanceKey(path, instanceId));
        applyIntent(editor, instanceIntent);
    }
    return () => {
        const current = editors.get(path);
        if (current?.get(registrationKey) !== editor) return;
        current.delete(registrationKey);
        if (current.size === 0) editors.delete(path);
    };
}

/**
 * The Monaco instance currently rendering `path`, for callers that need to run an editor action against it rather than
 * move its caret. Returns nothing when no editor is mounted for that document; there is no queue here, because an
 * action the user invoked applies to the editor they are looking at or to nothing at all.
 */
export function mountedEditor(path: string, instanceId?: string): MonacoEditor | undefined {
    return registeredEditor(path, instanceId);
}

/**
 * Reveals immediately when the model is mounted, otherwise queues one latest intent for mount.
 */
export function revealEditorMatch(path: string, target: EditorRevealTarget): void {
    const editor = registeredEditor(path);
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
 * Focuses a mounted Editor model or queues focus for the commit that mounts a newly opened model. A supplied instance
 * ID keeps a breadcrumb action in the pane that owns it when another pane renders the same Monaco model.
 */
export function focusEditor(path: string, instanceId?: string): void {
    const editor = registeredEditor(path, instanceId);
    if (editor) editor.focus();
    else if (instanceId)
        pendingByInstance.set(pendingInstanceKey(path, instanceId), { kind: 'focus' });
    else pending.set(path, { kind: 'focus' });
}

/**
 * Applies an exact caret or inclusive whole-line selection to an already mounted Editor.
 */
export function revealEditorNavigation(path: string, target: EditorNavigationTarget): void {
    const editor = registeredEditor(path);
    if (editor) applyNavigation(editor, target);
    else queueEditorNavigation(path, target);
}
