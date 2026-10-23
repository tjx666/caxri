import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { disposeAllThenRethrow } from '@caxri/utils';
import type { editor as MonacoEditor } from 'monaco-editor';

import { monaco } from '../../../lib/monaco';
import { selectionToolbarPosition } from '../../../lib/selection-toolbar-position';

/**
 * How long a selection made from the keyboard (Shift+Arrow, Select All) must hold still before the toolbar appears, so
 * it does not chase every step of a selection still being extended. Matches the Chat transcript's toolbar.
 */
const KEYBOARD_SELECTION_SETTLE_MS = 200;

function hasTextSelection(editor: MonacoEditor.ICodeEditor): boolean {
    const selection = editor.getSelection();
    const model = editor.getModel();
    return Boolean(
        selection && model && !selection.isEmpty() && model.getValueInRange(selection).trim(),
    );
}

/**
 * Places the toolbar against the selection's first line, inside the editor's text area (the gutter and scrollbar
 * excluded), or hides it while that line is scrolled away.
 */
function placeToolbar(editor: MonacoEditor.ICodeEditor, toolbar: HTMLElement): void {
    const selection = editor.getSelection();
    const node = editor.getDomNode();
    const start = selection && editor.getScrolledVisiblePosition(selection.getStartPosition());
    const end = selection && editor.getScrolledVisiblePosition(selection.getEndPosition());
    const editorBox = node?.getBoundingClientRect();
    const position =
        selection && start && end && editorBox && editorBox.height > 0
            ? (() => {
                  const layout = editor.getLayoutInfo();
                  const lineBox = (point: typeof start, right: number) => ({
                      top: editorBox.top + point.top,
                      bottom: editorBox.top + point.top + point.height,
                      left: editorBox.left + point.left,
                      right: editorBox.left + right,
                  });
                  const isOneLine = selection.startLineNumber === selection.endLineNumber;
                  return selectionToolbarPosition({
                      bounds: {
                          top: editorBox.top,
                          bottom: editorBox.bottom,
                          left: editorBox.left + layout.contentLeft,
                          right: editorBox.left + layout.width - layout.verticalScrollbarWidth,
                      },
                      first: lineBox(start, isOneLine ? end.left : start.left),
                      last: lineBox(end, end.left),
                      size: { width: toolbar.offsetWidth, height: toolbar.offsetHeight },
                  });
              })()
            : undefined;
    toolbar.style.visibility = position ? 'visible' : 'hidden';
    if (position) {
        toolbar.style.top = `${position.top}px`;
        toolbar.style.left = `${position.left}px`;
    }
}

/**
 * The toolbar that floats over text selected in a code editor (see `EditorSelectionToolbar`). Like the Chat
 * transcript's, it appears when the pointer that made the selection is released, or once a keyboard selection has held
 * still, and only while the editor has focus. It leaves when the selection collapses, on Escape, and when the editor
 * loses focus. While shown it follows the selection through scrolling and layout changes, and hides while the
 * selection's first line is scrolled out of view.
 */
export function useEditorSelectionToolbar(editor: MonacoEditor.ICodeEditor | undefined) {
    const toolbarReference = useRef<HTMLDivElement | null>(null);
    const [isShown, setIsShown] = useState(false);
    const dismiss = useCallback(() => setIsShown(false), []);
    useEffect(() => {
        if (!editor) return;
        let isPointerDown = false;
        let settle: ReturnType<typeof setTimeout> | undefined;
        const showIfSelected = (): void =>
            setIsShown(editor.hasTextFocus() && hasTextSelection(editor));
        const hide = (): void => {
            clearTimeout(settle);
            setIsShown(false);
        };
        const onPointerUp = (): void => {
            if (!isPointerDown) return;
            isPointerDown = false;
            // Monaco settles the selection on the same release; read it after.
            requestAnimationFrame(showIfSelected);
        };
        const disposables = [
            editor.onMouseDown(() => {
                isPointerDown = true;
                hide();
            }),
            editor.onDidChangeCursorSelection(() => {
                if (!hasTextSelection(editor)) {
                    hide();
                    return;
                }
                // A drag is shown on release instead; anything else changed the selection from the keyboard.
                if (isPointerDown) return;
                hide();
                settle = setTimeout(showIfSelected, KEYBOARD_SELECTION_SETTLE_MS);
            }),
            editor.onDidBlurEditorText(hide),
            editor.onKeyDown((event) => {
                if (event.keyCode === monaco.KeyCode.Escape) hide();
            }),
        ];
        // The release can land outside the editor when a drag selection overshoots it.
        document.addEventListener('pointerup', onPointerUp);
        return () => {
            clearTimeout(settle);
            document.removeEventListener('pointerup', onPointerUp);
            disposeAllThenRethrow(disposables);
        };
    }, [editor]);
    /**
     * Placing the toolbar writes its style directly: it follows every scroll frame, which would otherwise re-render the
     * toolbar once per frame, and it has to measure the toolbar it moves.
     */
    useLayoutEffect(() => {
        const toolbar = toolbarReference.current;
        if (!isShown || !editor || !toolbar) return;
        const place = (): void => placeToolbar(editor, toolbar);
        place();
        const disposables = [
            editor.onDidScrollChange(place),
            editor.onDidLayoutChange(place),
            editor.onDidChangeCursorSelection(place),
        ];
        return () => {
            disposeAllThenRethrow(disposables);
        };
    }, [editor, isShown]);
    return { dismiss, isShown, toolbarReference };
}
