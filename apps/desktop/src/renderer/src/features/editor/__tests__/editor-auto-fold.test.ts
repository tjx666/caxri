import { afterEach, describe, expect, it, vi } from 'vitest';

import { foldEditorOnOpen } from '../editor-auto-fold';
import { clearEditorViewStates, rememberEditorViewState } from '../editor-view-state';

type Editor = Parameters<typeof foldEditorOnOpen>[0];

const LONG_FILE = 'caxri://session/session-1/long-file.ts';
const THRESHOLD = 1_000;

interface MountedEditorOptions {
    modelUri?: string;
    lineCount?: number;
    /**
     * Where the caret sits once the remembered position and any queued reveal have been applied.
     */
    line?: number;
    column?: number;
    /**
     * Monaco hands out no Fold All action for a model it cannot fold.
     */
    foldable?: boolean;
}

function mountedEditor({
    modelUri = LONG_FILE,
    lineCount = 5_000,
    line = 1,
    column = 1,
    foldable = true,
}: MountedEditorOptions = {}) {
    const foldAll = vi.fn(() => Promise.resolve());
    const editor = {
        getAction: (id: string) =>
            foldable && id === 'editor.foldAll' ? { run: foldAll } : undefined,
        getModel: () => ({ getLineCount: () => lineCount, uri: { toString: () => modelUri } }),
        getPosition: () => ({ column, lineNumber: line }),
        restoreViewState: vi.fn(),
        saveViewState: () => 'view-state',
    };
    return { editor, foldAll };
}

function open(mounted: ReturnType<typeof mountedEditor>, threshold = THRESHOLD): void {
    foldEditorOnOpen(mounted.editor as unknown as Editor, 'pane-1', threshold);
}

afterEach(() => {
    clearEditorViewStates();
});

describe('Editor fold on open', () => {
    it('collapses a file longer than the threshold the first time it opens', () => {
        const mounted = mountedEditor({ lineCount: THRESHOLD + 1 });

        open(mounted);

        expect(mounted.foldAll).toHaveBeenCalledOnce();
    });

    /**
     * The setting reads as "fold above this length", so a file exactly at the threshold is still short enough to read.
     */
    it('leaves a file at the threshold expanded', () => {
        const mounted = mountedEditor({ lineCount: THRESHOLD });

        open(mounted);

        expect(mounted.foldAll).not.toHaveBeenCalled();
    });

    it('never folds when the threshold is zero', () => {
        const mounted = mountedEditor({ lineCount: 100_000 });

        open(mounted, 0);

        expect(mounted.foldAll).not.toHaveBeenCalled();
    });

    /**
     * Leaving a document and coming back restores the folds the user left behind. Refolding there would quietly undo
     * every region they had expanded.
     */
    it('leaves a document this pane has already shown to its remembered folds', () => {
        rememberEditorViewState(mountedEditor().editor as unknown as Editor, 'pane-1');
        const reopened = mountedEditor();

        open(reopened);

        expect(reopened.foldAll).not.toHaveBeenCalled();
    });

    it('still folds a document another pane has shown', () => {
        rememberEditorViewState(mountedEditor().editor as unknown as Editor, 'pane-2');
        const mounted = mountedEditor();

        open(mounted);

        expect(mounted.foldAll).toHaveBeenCalledOnce();
    });

    /**
     * A search hit or a Terminal `path:line` link places the caret before this runs. Folding would pull that caret back
     * to the enclosing region's first line, so the jump the user asked for would land somewhere else.
     */
    it('leaves a document opened at a specific line alone', () => {
        const mounted = mountedEditor({ line: 520 });

        open(mounted);

        expect(mounted.foldAll).not.toHaveBeenCalled();
    });

    it('opens the file unfolded when Monaco has no folding for the model', () => {
        const mounted = mountedEditor({ foldable: false });

        expect(() => {
            open(mounted);
        }).not.toThrow();
    });
});
