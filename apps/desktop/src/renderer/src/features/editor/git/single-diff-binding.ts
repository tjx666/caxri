import type { editor as Monaco } from 'monaco-editor';

import type { DiffEditorActions } from './diff-actions';
import { codeEditorFileSelection, registerDiffEditorActions } from './diff-actions';

export type SingleDiffKind = 'added' | 'deleted';

/**
 * A trailing newline terminates the last changed line; it does not add a phantom EOF line.
 */
function changedLineCount(editor: Monaco.IStandaloneCodeEditor): number {
    const model = editor.getModel();
    if (!model || model.getValueLength() === 0) return 0;
    const count = model.getLineCount();
    return model.getLineContent(count) === '' ? count - 1 : count;
}

/**
 * Represents an all-added/all-deleted document as one hunk without inventing an empty opposite model. Both toolbar
 * directions wrap to this hunk, just as Monaco's diff navigator wraps when a comparison has only one change.
 */
export function bindSingleDiffEditor(
    editor: Monaco.IStandaloneCodeEditor,
    kind: SingleDiffKind,
    options: {
        editorInstanceId?: string;
        navigationKey?: string;
        onContentHeightChange?: (height: number) => void;
    },
): () => void {
    const decorations = editor.createDecorationsCollection();
    const syncDecorations = (): void => {
        const lineCount = changedLineCount(editor);
        decorations.set(
            lineCount === 0
                ? []
                : [
                      {
                          range: {
                              startLineNumber: 1,
                              startColumn: 1,
                              endLineNumber: lineCount,
                              endColumn: 1,
                          },
                          options: {
                              isWholeLine: true,
                              className: `git-${kind}-line`,
                              marginClassName: `git-${kind}-line`,
                              linesDecorationsClassName: `git-${kind}-indicator`,
                          },
                      },
                  ],
        );
    };
    const syncHeight = (): void =>
        options.onContentHeightChange?.(
            editor.getContentHeight() + editor.getLayoutInfo().horizontalScrollbarHeight,
        );
    const contentListener = editor.onDidChangeModelContent(syncDecorations);
    const modelListener = editor.onDidChangeModel(syncDecorations);
    const sizeListener = editor.onDidContentSizeChange(syncHeight);
    const actions: DiffEditorActions = {
        focus: () => editor.focus(),
        // An `added` document is the new file, so its own line numbers address it directly. A `deleted` one numbers
        // content that no longer exists; callers gate that separately, the way the toolbar disables Open Current File.
        getFileSelection: () => codeEditorFileSelection(editor),
        getLineChanges: () => {
            const count = changedLineCount(editor);
            if (!count) return [];
            return [
                {
                    charChanges: undefined,
                    originalStartLineNumber: kind === 'deleted' ? 1 : 0,
                    originalEndLineNumber: kind === 'deleted' ? count : 0,
                    modifiedStartLineNumber: kind === 'added' ? 1 : 0,
                    modifiedEndLineNumber: kind === 'added' ? count : 0,
                },
            ];
        },
        onDidUpdateDiff: (listener) => {
            const notify = (): void => {
                listener();
            };
            const content = editor.onDidChangeModelContent(notify);
            const model = editor.onDidChangeModel(notify);
            return {
                dispose: () => {
                    content.dispose();
                    model.dispose();
                },
            };
        },
        goToDiff: () => {
            editor.setPosition({ lineNumber: 1, column: 1 });
            editor.revealLineInCenter(1);
            editor.focus();
        },
    };
    const unregister =
        options.navigationKey && options.editorInstanceId
            ? registerDiffEditorActions(options.navigationKey, options.editorInstanceId, actions)
            : undefined;
    syncDecorations();
    syncHeight();
    return () => {
        unregister?.();
        contentListener.dispose();
        modelListener.dispose();
        sizeListener.dispose();
        decorations.clear();
    };
}
