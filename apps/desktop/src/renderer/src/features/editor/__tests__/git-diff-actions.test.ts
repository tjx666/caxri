import type { MonacoDiffEditor } from '@monaco-editor/react';
import { describe, expect, it, vi } from 'vitest';

import {
    didNavigateDiffEditor,
    getDiffEditorActionState,
    registerDiffEditorActions,
    subscribeDiffEditorActions,
} from '../git-diff-actions';

interface FakeDiffEditor {
    editor: MonacoDiffEditor;
    goToDiff: ReturnType<typeof vi.fn>;
    setChanges: (hasChanges: boolean) => void;
}

function fakeDiffEditor(): FakeDiffEditor {
    let hasChanges = false;
    const listeners = new Set<() => void>();
    const goToDiff = vi.fn();
    const editor = {
        getLineChanges: () => (hasChanges ? [{}] : null),
        goToDiff,
        onDidUpdateDiff: (listener: () => void) => {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
    } as unknown as MonacoDiffEditor;
    return {
        editor,
        goToDiff,
        setChanges: (next) => {
            hasChanges = next;
            for (const listener of listeners) listener();
        },
    };
}

describe('Git diff editor actions', () => {
    it('keeps navigation disabled until the mounted Monaco diff has changes', () => {
        const fake = fakeDiffEditor();
        const listener = vi.fn();
        const unsubscribe = subscribeDiffEditorActions('/diff', 'pane-1', listener);
        const unregister = registerDiffEditorActions('/diff', 'pane-1', fake.editor);

        expect(getDiffEditorActionState('/diff', 'pane-1')).toEqual({ hasChanges: false });
        expect(didNavigateDiffEditor('/diff', 'pane-1', 'next')).toBe(false);
        expect(fake.goToDiff).not.toHaveBeenCalled();

        fake.setChanges(true);

        expect(getDiffEditorActionState('/diff', 'pane-1')).toEqual({ hasChanges: true });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(didNavigateDiffEditor('/diff', 'pane-1', 'next')).toBe(true);
        expect(fake.goToDiff).toHaveBeenCalledWith('next');

        unregister();
        expect(getDiffEditorActionState('/diff', 'pane-1')).toEqual({ hasChanges: false });
        expect(didNavigateDiffEditor('/diff', 'pane-1', 'previous')).toBe(false);
        unsubscribe();
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
});
