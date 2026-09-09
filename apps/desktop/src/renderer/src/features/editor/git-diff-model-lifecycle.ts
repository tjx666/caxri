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
