import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    clearEditorViewStates,
    rememberEditorViewState,
    restoreEditorViewState,
} from '../editor-view-state';

type Editor = Parameters<typeof rememberEditorViewState>[0];

function editor(modelUri: string | undefined, viewState: unknown = 'view-state') {
    return {
        getModel: () => (modelUri ? { uri: { toString: () => modelUri } } : null),
        restoreViewState: vi.fn(),
        saveViewState: () => viewState,
    };
}

function remember(mounted: ReturnType<typeof editor>, instanceId?: string): void {
    rememberEditorViewState(mounted as unknown as Editor, instanceId);
}

function restore(mounted: ReturnType<typeof editor>, instanceId?: string): void {
    restoreEditorViewState(mounted as unknown as Editor, instanceId);
}

afterEach(() => {
    clearEditorViewStates();
});

describe('Editor view state', () => {
    it('returns a remounted editor to where the disposed one was looking', () => {
        const path = 'caxri://session/session-1/AGENTS.md';
        remember(editor(path, 'scrolled-to-line-145'), 'pane-1');

        const remounted = editor(path);
        restore(remounted, 'pane-1');

        expect(remounted.restoreViewState).toHaveBeenCalledWith('scrolled-to-line-145');
    });

    it('keeps two panes showing one file independent', () => {
        const path = 'caxri://session/session-1/AGENTS.md';
        remember(editor(path, 'top-of-file'), 'pane-1');
        remember(editor(path, 'bottom-of-file'), 'pane-2');

        const remounted = editor(path);
        restore(remounted, 'pane-2');

        expect(remounted.restoreViewState).toHaveBeenCalledWith('bottom-of-file');
    });

    /**
     * The model URI carries the Session, so the same file opened under another Session is a different document and must
     * not inherit a scroll position from the Session the user switched away from.
     */
    it('does not carry a position across Sessions or files', () => {
        remember(editor('caxri://session/session-1/AGENTS.md', 'session-1-position'), 'pane-1');

        const otherSession = editor('caxri://session/session-2/AGENTS.md');
        const otherFile = editor('caxri://session/session-1/README.md');
        restore(otherSession, 'pane-1');
        restore(otherFile, 'pane-1');

        expect(otherSession.restoreViewState).not.toHaveBeenCalledWith('session-1-position');
        expect(otherFile.restoreViewState).not.toHaveBeenCalledWith('session-1-position');
    });

    it('ignores an editor whose model is already gone', () => {
        remember(editor(undefined, 'orphaned-position'), 'pane-1');
        const detached = editor(undefined);
        restore(detached, 'pane-1');

        const remounted = editor('caxri://session/session-1/AGENTS.md');
        restore(remounted, 'pane-1');

        expect(detached.restoreViewState).not.toHaveBeenCalled();
        expect(remounted.restoreViewState).not.toHaveBeenCalledWith('orphaned-position');
    });

    /**
     * Monaco reports visible lines to a model's tokenizer only through a view-state restore, a scroll, or a line-count
     * change; without this signal a document opened at the top waits for idle-time background tokenization.
     */
    it('re-applies the current view of a document shown for the first time', () => {
        const firstOpen = editor('caxri://session/session-1/AGENTS.md', 'top-of-file');
        restore(firstOpen, 'pane-1');

        expect(firstOpen.restoreViewState).toHaveBeenCalledExactlyOnceWith('top-of-file');
    });

    it('evicts the least recently used document once the cache is full', () => {
        const path = (index: number) => `caxri://session/session-1/file-${index}.ts`;
        for (let index = 0; index < 100; index += 1)
            remember(editor(path(index), `position-${index}`), 'pane-1');
        // Touching the oldest entry makes it the most recent, so the next insert evicts the second oldest instead.
        restore(editor(path(0)), 'pane-1');

        remember(editor(path(100), 'position-100'), 'pane-1');

        const oldest = editor(path(0));
        const evicted = editor(path(1));
        const newest = editor(path(100));
        restore(oldest, 'pane-1');
        restore(evicted, 'pane-1');
        restore(newest, 'pane-1');

        expect(oldest.restoreViewState).toHaveBeenCalledWith('position-0');
        expect(evicted.restoreViewState).not.toHaveBeenCalledWith('position-1');
        expect(newest.restoreViewState).toHaveBeenCalledWith('position-100');
    });
});
