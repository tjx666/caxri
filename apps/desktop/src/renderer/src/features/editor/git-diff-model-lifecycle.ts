import type { editor } from 'monaco-editor';

/**
 * Own the diff view model explicitly: detaching the widget does not guarantee cancellation of its worker computation.
 * Cancel that computation before releasing either text model, including during stacked-editor virtualization.
 *
 * @see https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/widget/diffEditor/diffEditorWidget.ts
 */
export function disposeGitDiffModels(
    editor: { setModel(model: null): void; dispose(): void },
    viewModel: { dispose(): void },
    models: { original: { dispose(): void }; modified: { dispose(): void } },
): void {
    editor.setModel(null);
    viewModel.dispose();
    editor.dispose();
    models.original.dispose();
    models.modified.dispose();
}
/**
 * Include the overlay scrollbar so stacked editors fit their content without recapturing wheel scrolling.
 */
export function observeGitEditorContentHeight(
    editors: editor.IStandaloneCodeEditor[],
    scrollbarEditor: editor.IStandaloneCodeEditor,
    onContentHeightChange?: (height: number) => void,
): Array<{ dispose(): void }> {
    const syncHeight = (): void =>
        onContentHeightChange?.(
            Math.max(...editors.map((instance) => instance.getContentHeight())) +
                scrollbarEditor.getLayoutInfo().horizontalScrollbarHeight,
        );
    const listeners = editors.map((instance) => instance.onDidContentSizeChange(syncHeight));
    syncHeight();
    return listeners;
}
