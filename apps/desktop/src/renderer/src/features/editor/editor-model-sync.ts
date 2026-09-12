import type { editor as Monaco } from 'monaco-editor';

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
