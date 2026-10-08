import type { OnMount } from '@monaco-editor/react';

import { hasEditorViewState } from './editor-view-state';

type MonacoEditor = Parameters<OnMount>[0];

/**
 * Monaco's own Fold All command, the one bound to `Cmd+K Cmd+0`. Running the registered action rather than reaching
 * into the folding controller is what makes this safe to invoke straight after mount: the action resolves the folding
 * model first, and that promise is the debounced range computation the controller schedules when a model is attached,
 * so there is no race with the language's folding range provider to time around.
 */
const FOLD_ALL_ACTION = 'editor.foldAll';

interface FoldOnOpenInput {
    lineCount: number;
    /**
     * `editor.foldOnOpenLineThreshold`. Only a file strictly longer than this folds, and `0` turns the behavior off.
     */
    threshold: number;
    /**
     * Whether this pane already remembers where it was looking in this document. A remembered view state carries the
     * user's own folded ranges, so it has to win.
     */
    hasRememberedViewState: boolean;
    cursorLine: number;
    cursorColumn: number;
}

/**
 * Whether a freshly opened document should be collapsed to its structure.
 *
 * Two guards keep this from fighting the user. A document this pane has shown before is restored, not refolded:
 * expanding a few regions and switching tabs would otherwise undo itself on every return. And a caret that is not at
 * the very start means something navigated here by line: a search hit, a Terminal `path:line` link, a breadcrumb jump.
 * Folding then would not merely hide the surrounding file, it would move the caret (Monaco pulls a selection that lands
 * inside a collapsed region back to that region's first line) so the jump the user asked for would silently land
 * somewhere else.
 */
function shouldFoldOnOpen({
    lineCount,
    threshold,
    hasRememberedViewState,
    cursorLine,
    cursorColumn,
}: FoldOnOpenInput): boolean {
    if (threshold <= 0) return false;
    if (lineCount <= threshold) return false;
    if (hasRememberedViewState) return false;
    return cursorLine === 1 && cursorColumn === 1;
}

/**
 * Folding the whole document is a convenience, never a correctness step. Monaco hands out no Fold All action for a
 * model it cannot fold, and the action's own promise can reject when the editor is disposed while the folding ranges
 * are still being computed: a tab closed the moment it opened. Either way the file simply opens unfolded.
 */
async function foldAllIgnoringFailure(editor: MonacoEditor): Promise<void> {
    try {
        await editor.getAction(FOLD_ALL_ACTION)?.run();
    } catch {
        // Nothing about opening the document depends on this succeeding.
    }
}

/**
 * Collapses every foldable region the first time a long document opens in this pane, so a file that is too long to read
 * top to bottom opens as an outline of itself instead: the `Cmd+K Cmd+0` a user would otherwise press by hand.
 */
export function foldEditorOnOpen(
    editor: MonacoEditor,
    editorInstanceId: string | undefined,
    threshold: number,
): void {
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position) return;
    const isFoldedOnOpen = shouldFoldOnOpen({
        lineCount: model.getLineCount(),
        threshold,
        hasRememberedViewState: hasEditorViewState(editor, editorInstanceId),
        cursorLine: position.lineNumber,
        cursorColumn: position.column,
    });
    if (!isFoldedOnOpen) return;
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see `foldAllIgnoringFailure`
    void foldAllIgnoringFailure(editor);
}
