import type { MonacoDiffEditor } from '@monaco-editor/react';
import type { editor as Monaco } from 'monaco-editor';
import { describe, expect, it, vi } from 'vitest';

import type { DiffEditorActions } from '../diff-actions';
import {
    didFocusDiffEditor,
    didNavigateDiffEditor,
    getDiffEditorActionState,
    getDiffEditorFileSelection,
    monacoDiffEditorActions,
    registerDiffEditorActions,
    subscribeDiffEditorActions,
} from '../diff-actions';

interface FakeDiffEditor {
    editor: DiffEditorActions;
    focus: ReturnType<typeof vi.fn>;
    goToDiff: ReturnType<typeof vi.fn>;
    setChanges: (hasChanges: boolean) => void;
}

function fakeDiffEditor(): FakeDiffEditor {
    let hasChanges = false;
    const listeners = new Set<() => void>();
    const focus = vi.fn();
    const goToDiff = vi.fn();
    const editor = {
        focus,
        getFileSelection: () => {},
        getLineChanges: () => (hasChanges ? [{}] : null),
        goToDiff,
        onDidUpdateDiff: (listener: () => void) => {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
    } as unknown as DiffEditorActions;
    return {
        editor,
        focus,
        goToDiff,
        setChanges: (next) => {
            hasChanges = next;
            for (const listener of listeners) listener();
        },
    };
}

function fakeCodeEditor(selection?: {
    endColumn: number;
    endLine: number;
    startColumn: number;
    startLine: number;
}): Monaco.ICodeEditor {
    return {
        getSelection: () =>
            selection && {
                positionLineNumber: selection.endLine,
                positionColumn: selection.endColumn,
                getStartPosition: () => ({ lineNumber: selection.startLine }),
                getEndPosition: () => ({
                    lineNumber: selection.endLine,
                    column: selection.endColumn,
                }),
            },
    } as unknown as Monaco.ICodeEditor;
}

describe('Git diff editor actions', () => {
    it('keeps navigation disabled until the mounted Monaco diff has changes', () => {
        const fake = fakeDiffEditor();
        const listener = vi.fn();
        const unsubscribe = subscribeDiffEditorActions('/diff', 'pane-1', listener);
        const unregister = registerDiffEditorActions('/diff', 'pane-1', fake.editor);

        expect(getDiffEditorActionState('/diff', 'pane-1')).toEqual({ hasChanges: false });
        expect(didNavigateDiffEditor('/diff', 'pane-1', 'next')).toBe(false);
        expect(didFocusDiffEditor('/diff', 'pane-1')).toBe(true);
        expect(fake.focus).toHaveBeenCalledTimes(1);
        expect(fake.goToDiff).not.toHaveBeenCalled();

        fake.setChanges(true);

        expect(getDiffEditorActionState('/diff', 'pane-1')).toEqual({ hasChanges: true });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(didNavigateDiffEditor('/diff', 'pane-1', 'next')).toBe(true);
        expect(fake.goToDiff).toHaveBeenCalledWith('next');

        unregister();
        expect(getDiffEditorActionState('/diff', 'pane-1')).toEqual({ hasChanges: false });
        expect(didNavigateDiffEditor('/diff', 'pane-1', 'previous')).toBe(false);
        expect(didFocusDiffEditor('/diff', 'pane-1')).toBe(false);
        unsubscribe();
    });

    it('notifies a later subscriber when an earlier one throws', () => {
        const fake = fakeDiffEditor();
        const failing = vi.fn(() => {
            throw new Error('diff actions listener failure');
        });
        const surviving = vi.fn();
        const unsubscribeFailing = subscribeDiffEditorActions('/diff', 'pane-1', failing);
        const unsubscribeSurviving = subscribeDiffEditorActions('/diff', 'pane-1', surviving);
        const unregister = registerDiffEditorActions('/diff', 'pane-1', fake.editor);
        vi.spyOn(console, 'error').mockImplementation(() => {});

        fake.setChanges(true);

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledTimes(1);
        unregister();
        unsubscribeFailing();
        unsubscribeSurviving();
        vi.restoreAllMocks();
    });

    it('keeps split-pane diff registrations independent', () => {
        const first = fakeDiffEditor();
        const second = fakeDiffEditor();
        const unregisterFirst = registerDiffEditorActions('/diff', 'pane-1', first.editor);
        const unregisterSecond = registerDiffEditorActions('/diff', 'pane-2', second.editor);

        first.setChanges(true);

        expect(getDiffEditorActionState('/diff', 'pane-1')).toEqual({ hasChanges: true });
        expect(getDiffEditorActionState('/diff', 'pane-2')).toEqual({ hasChanges: false });
        expect(didNavigateDiffEditor('/diff', 'pane-2', 'next')).toBe(false);

        unregisterFirst();
        unregisterSecond();
    });

    it('reads the caret from the modified side, which numbers lines the way the file does', () => {
        const modified = fakeCodeEditor({
            endColumn: 7,
            endLine: 1251,
            startColumn: 7,
            startLine: 1251,
        });
        const editor = {
            focus: vi.fn(),
            getLineChanges: () => null,
            getModifiedEditor: () => modified,
            goToDiff: vi.fn(),
            onDidUpdateDiff: () => ({ dispose: () => {} }),
        } as unknown as MonacoDiffEditor;
        const unregister = registerDiffEditorActions(
            '/diff',
            'pane-1',
            monacoDiffEditorActions(editor),
        );

        expect(getDiffEditorFileSelection('/diff', 'pane-1')).toEqual({
            line: 1251,
            column: 7,
            selectionStartLine: 1251,
            selectionEndLine: 1251,
        });

        unregister();
        expect(getDiffEditorFileSelection('/diff', 'pane-1')).toBeUndefined();
    });

    it('excludes a trailing line the selection only touches at its first column', () => {
        const editor = {
            focus: vi.fn(),
            getLineChanges: () => null,
            getModifiedEditor: () =>
                fakeCodeEditor({ endColumn: 1, endLine: 9, startColumn: 3, startLine: 3 }),
            goToDiff: vi.fn(),
            onDidUpdateDiff: () => ({ dispose: () => {} }),
        } as unknown as MonacoDiffEditor;
        const unregister = registerDiffEditorActions(
            '/diff',
            'pane-2',
            monacoDiffEditorActions(editor),
        );

        expect(getDiffEditorFileSelection('/diff', 'pane-2')).toMatchObject({
            selectionStartLine: 3,
            selectionEndLine: 8,
        });

        unregister();
    });

    it('reports no position while no diff editor is mounted for the tab occurrence', () => {
        expect(getDiffEditorFileSelection('/diff', 'pane-absent')).toBeUndefined();
    });
});
