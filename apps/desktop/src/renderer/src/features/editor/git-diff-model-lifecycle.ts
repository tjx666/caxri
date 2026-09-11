import type { editor } from 'monaco-editor';

/**
 * Runs one teardown step and reports a failure instead of propagating it, so the steps after it still run.
 */
function releaseGitDiffResource(step: string, release: () => void): void {
    try {
        release();
    } catch (error) {
        // Desktop mirrors renderer `console.error` into `logs/desktop.jsonl`, which is the only reporting path a
        // teardown has: there is no surface left to show a notification on, and the user cannot act on this anyway.
        console.error(`Git diff teardown failed at ${step}`, error);
    }
}

/**
 * Own the diff view model explicitly: detaching the widget does not guarantee cancellation of its worker computation.
 * Cancel that computation before releasing either text model, including during stacked-editor virtualization.
 *
 * Every step is isolated because Monaco can throw out of widget teardown, and an exception raised inside a React
 * layout-effect cleanup reaches the top-level `ErrorBoundary` and replaces the whole workbench with the crash screen.
 * The concrete case: `StandaloneCodeEditor`'s constructor installs a _module-global_ hover-delegate factory bound to
 * that one editor's `InstantiationService`, so when a stacked diff list tears several editors down together, a
 * `SuggestWidget` built during dispose asks an already-disposed service for a hover delegate and `InstantiationService
 * has been disposed` escapes `DisposableStore.dispose` as an `AggregateError`. Isolating the steps also keeps that
 * failure from stranding the two text models, which would leak for the window's lifetime.
 *
 * @see https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/widget/diffEditor/diffEditorWidget.ts
 */
export function disposeGitDiffModels(
    editor: { setModel(model: null): void; dispose(): void },
    viewModel: { dispose(): void },
    models: { original: { dispose(): void }; modified: { dispose(): void } },
): void {
    releaseGitDiffResource('detach', () => editor.setModel(null));
    releaseGitDiffResource('view model', () => viewModel.dispose());
    releaseGitDiffResource('editor', () => editor.dispose());
    releaseGitDiffResource('original model', () => models.original.dispose());
    releaseGitDiffResource('modified model', () => models.modified.dispose());
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
