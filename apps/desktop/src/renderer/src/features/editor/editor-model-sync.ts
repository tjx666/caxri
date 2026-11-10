import { editorModelPath } from '@desktop-shared/editor-state';
import type { editor as Monaco } from 'monaco-editor';

import { monaco } from '../../lib/monaco';
import { useSessionViewStore } from '../../stores/session-view';

/**
 * Reconciles the controlled value after a Monaco path-model handoff.
 *
 * `@monaco-editor/react` binds the model in a path-only effect and applies content in a separate value-only effect. If
 * two existing models receive the same controlled value, the second model can retain stale content when selected.
 *
 * @see https://github.com/suren-atoyan/monaco-react/blob/v4.7.0/src/Editor/Editor.tsx
 */
export function synchronizeControlledEditorModel(
    editor: Monaco.IStandaloneCodeEditor,
    expectedUri: string,
    value: string,
    programmaticChange: { current: boolean },
): void {
    const model = editor.getModel();
    if (!model || model.uri.toString() !== expectedUri || model.getValue() === value) return;
    programmaticChange.current = true;
    try {
        editor.executeEdits('caxri-controlled-value', [
            { range: model.getFullModelRange(), text: value, forceMoveMarkers: true },
        ]);
        editor.pushUndoStop();
    } finally {
        programmaticChange.current = false;
    }
}

/**
 * File editor model URIs that `CodeEditor` asked `@monaco-editor/react` to keep. Only these are ever released here, so
 * the diff, transcript, and Settings editors keep owning their own models.
 */
const retainedModelUris = new Set<string>();

const retention: { isReleaseScheduled: boolean; isSubscribed: boolean } = {
    isReleaseScheduled: false,
    isSubscribed: false,
};

/**
 * Picks the kept models whose document left the Session document cache and that no editor widget shows any more.
 *
 * A model still attached to a widget waits for the next sweep: disposing it would blank a visible editor, and the
 * widget's own unmount or path change schedules that sweep.
 */
function selectReleasableEditorModels(
    retained: Iterable<string>,
    liveDocumentUris: ReadonlySet<string>,
    attachedUris: ReadonlySet<string>,
): string[] {
    return [...retained].filter((uri) => !liveDocumentUris.has(uri) && !attachedUris.has(uri));
}

function liveDocumentModelUris(): Set<string> {
    const live = new Set<string>();
    for (const [scope, documents] of Object.entries(useSessionViewStore.getState().documents))
        for (const path of Object.keys(documents))
            live.add(monaco.Uri.parse(editorModelPath(scope, path)).toString());
    return live;
}

function releaseClosedEditorModels(): void {
    retention.isReleaseScheduled = false;
    const attached = new Set<string>();
    for (const editor of monaco.editor.getEditors()) {
        const uri = editor.getModel()?.uri.toString();
        if (uri) attached.add(uri);
    }
    for (const uri of selectReleasableEditorModels(
        retainedModelUris,
        liveDocumentModelUris(),
        attached,
    )) {
        retainedModelUris.delete(uri);
        monaco.editor.getModel(monaco.Uri.parse(uri))?.dispose();
    }
}

/**
 * Defers the sweep past the current React commit, so a widget that is unmounting or switching models has already let go
 * of the outgoing model when it runs.
 */
export function scheduleEditorModelRelease(): void {
    if (retention.isReleaseScheduled) return;
    retention.isReleaseScheduled = true;
    setTimeout(releaseClosedEditorModels, 0);
}

/**
 * Keeps a file editor's Monaco model, and with it the undo history, alive while its document stays in the Session
 * document cache.
 *
 * `@monaco-editor/react` disposes the current model when its widget unmounts unless `keepCurrentModel` is set, and a
 * pane unmounts the editor whenever it shows a Chat, Terminal, or other non-file tab. The model then came back from the
 * cached text with an empty undo stack, so Cmd+Z did nothing after switching away and back. The same disposal also
 * cleared the history of a split pane that still showed the file. Keeping the model moves its lifetime to the document
 * cache: a document closed, discarded, or evicted from the cache releases its model on the next sweep.
 */
export function retainEditorModel(modelUri: string): void {
    retainedModelUris.add(monaco.Uri.parse(modelUri).toString());
    if (retention.isSubscribed) return;
    retention.isSubscribed = true;
    // Lives as long as the window, like the store it watches.
    useSessionViewStore.subscribe((state, previous) => {
        if (state.documents !== previous.documents) scheduleEditorModelRelease();
    });
}
