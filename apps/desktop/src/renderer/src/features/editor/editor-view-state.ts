import type { OnMount } from '@monaco-editor/react';

type MonacoEditor = Parameters<OnMount>[0];
type MonacoEditorViewState = NonNullable<ReturnType<MonacoEditor['saveViewState']>>;

/**
 * Upper bound on remembered editors. Each entry is a small record (cursor, scroll offsets, folded ranges), and a
 * document that is never reopened would otherwise keep its entry for the lifetime of the window. Oldest-first eviction
 * keeps the documents a user actually moves between, which is the case this cache exists for.
 */
const VIEW_STATE_LIMIT = 100;

/**
 * Monaco view states by `${model URI}\0${pane}`. A Session switch remounts the whole pane tree and
 * `@monaco-editor/react` disposes the widget with it, so nothing inside Monaco survives to restore scroll and cursor
 * from — the position has to be held outside the component that dies. Keying on the model URI (which already carries
 * the Session and file identity, see `editorModelPath`) plus the pane keeps two split panes showing one file
 * independent, which is exactly what the wrapper's own path-keyed cache cannot express.
 */
const viewStates = new Map<string, MonacoEditorViewState>();

function viewStateKey(modelUri: string, editorInstanceId: string | undefined): string {
    return `${modelUri}\0${editorInstanceId ?? ''}`;
}

function currentModelUri(editor: MonacoEditor): string | undefined {
    return editor.getModel()?.uri.toString();
}

/**
 * Records where the editor is looking right now. Call this while Monaco is still alive — from a layout-effect cleanup,
 * which React runs before the wrapper's passive cleanup disposes the widget, and before a `path` change swaps in
 * another model.
 */
export function rememberEditorViewState(
    editor: MonacoEditor,
    editorInstanceId: string | undefined,
): void {
    const modelUri = currentModelUri(editor);
    if (!modelUri) return;
    const state = editor.saveViewState();
    if (!state) return;
    const key = viewStateKey(modelUri, editorInstanceId);
    // Re-inserting moves the entry to the end, so eviction below drops the least recently used editor.
    viewStates.delete(key);
    viewStates.set(key, state);
    while (viewStates.size > VIEW_STATE_LIMIT) {
        const oldest = viewStates.keys().next();
        if (oldest.done) break;
        viewStates.delete(oldest.value);
    }
}

/**
 * Restores the remembered position for whichever model the editor currently holds. A document nobody has scrolled yet
 * is left at Monaco's own starting position.
 */
export function restoreEditorViewState(
    editor: MonacoEditor,
    editorInstanceId: string | undefined,
): void {
    const modelUri = currentModelUri(editor);
    if (!modelUri) return;
    const key = viewStateKey(modelUri, editorInstanceId);
    const state = viewStates.get(key);
    if (!state) return;
    // Re-inserting keeps a document the user keeps returning to out of the eviction path.
    viewStates.delete(key);
    viewStates.set(key, state);
    editor.restoreViewState(state);
}

/**
 * Test seam: the cache is module state shared by every editor in the window.
 */
export function clearEditorViewStates(): void {
    viewStates.clear();
}
