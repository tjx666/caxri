import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    focusEditor,
    hasPendingEditorIntent,
    queueEditorNavigation,
    registerEditorRevealTarget,
    revealEditorNavigation,
} from '../editor-reveal';

function editor(lineCount = 30) {
    return {
        focus: vi.fn(),
        getModel: () => ({
            getLineCount: () => lineCount,
            getLineMaxColumn: () => 11,
        }),
        revealLineInCenter: vi.fn(),
        setSelection: vi.fn(),
    };
}

function mount(path: string, mounted: ReturnType<typeof editor>, instanceId?: string): void {
    const unregister = registerEditorRevealTarget(
        path,
        mounted as unknown as Parameters<typeof registerEditorRevealTarget>[1],
        instanceId,
    );
    onTestFinished(unregister);
}

describe('Editor navigation', () => {
    it('selects every requested line and focuses the mounted Editor', () => {
        const mounted = editor();
        mount('/project/range.ts', mounted);

        revealEditorNavigation('/project/range.ts', {
            mode: 'line',
            startLine: 20,
            endLine: 21,
        });

        expect(mounted.setSelection).toHaveBeenCalledWith({
            startLineNumber: 20,
            startColumn: 1,
            endLineNumber: 21,
            endColumn: 11,
        });
        expect(mounted.revealLineInCenter).toHaveBeenCalledWith(20, 1);
        expect(mounted.focus).toHaveBeenCalledOnce();
    });

    it('selects through the final line without addressing a line past EOF', () => {
        const mounted = editor(21);
        mount('/project/eof.ts', mounted);

        revealEditorNavigation('/project/eof.ts', {
            mode: 'line',
            startLine: 20,
            endLine: 21,
        });

        expect(mounted.setSelection).toHaveBeenCalledWith({
            startLineNumber: 20,
            startColumn: 1,
            endLineNumber: 21,
            endColumn: 11,
        });
    });

    it('preserves an explicit caret and consumes a queued line intent on mount', () => {
        const caret = editor();
        mount('/project/caret.ts', caret);
        revealEditorNavigation('/project/caret.ts', { mode: 'caret', line: 12, column: 4 });
        expect(caret.setSelection).toHaveBeenCalledWith({
            startLineNumber: 12,
            startColumn: 4,
            endLineNumber: 12,
            endColumn: 4,
        });
        const queued = editor();
        queueEditorNavigation('/project/queued.ts', {
            mode: 'line',
            startLine: 7,
            endLine: 7,
        });
        mount('/project/queued.ts', queued);
        expect(queued.setSelection).toHaveBeenCalledWith({
            startLineNumber: 7,
            startColumn: 1,
            endLineNumber: 7,
            endColumn: 11,
        });
        expect(queued.focus).toHaveBeenCalledOnce();
    });

    it('focuses a mounted Editor immediately and a newly opened Editor after mount', () => {
        const mounted = editor();
        mount('/project/mounted.ts', mounted);
        focusEditor('/project/mounted.ts');
        expect(mounted.focus).toHaveBeenCalledOnce();

        focusEditor('/project/queued-focus.ts');
        const queued = editor();
        mount('/project/queued-focus.ts', queued);
        expect(queued.focus).toHaveBeenCalledOnce();
    });

    /**
     * `openFileForSession` queues the location and then focuses the same model in the same tick, so both intents land
     * under one key before Monaco's lazy import resolves. A Terminal `path:line` link that opened the file with the
     * caret still on line 1 is what the losing order looks like.
     */
    it('keeps a queued location when focus is requested for the same unmounted model', () => {
        queueEditorNavigation('/project/located.ts', { mode: 'caret', line: 32, column: 1 });
        focusEditor('/project/located.ts');

        const queued = editor();
        mount('/project/located.ts', queued);
        expect(queued.setSelection).toHaveBeenCalledWith({
            startLineNumber: 32,
            startColumn: 1,
            endLineNumber: 32,
            endColumn: 1,
        });
        expect(queued.revealLineInCenter).toHaveBeenCalledWith(32, 1);
        expect(queued.focus).toHaveBeenCalledOnce();
    });

    it('focuses the exact pane when one model is mounted in multiple Editors', () => {
        const left = editor();
        const right = editor();
        mount('/project/shared.ts', left, 'pane-left');
        mount('/project/shared.ts', right, 'pane-right');

        focusEditor('/project/shared.ts', 'pane-left');
        expect(left.focus).toHaveBeenCalledOnce();
        expect(right.focus).not.toHaveBeenCalled();

        focusEditor('/project/queued-shared.ts', 'pane-left');
        const queuedRight = editor();
        const queuedLeft = editor();
        mount('/project/queued-shared.ts', queuedRight, 'pane-right');
        mount('/project/queued-shared.ts', queuedLeft, 'pane-left');
        expect(queuedRight.focus).not.toHaveBeenCalled();
        expect(queuedLeft.focus).toHaveBeenCalledOnce();
    });
});

/**
 * The signal `useTabFocusRecovery` reads to stand down. Monaco is lazily imported, so between opening a file with focus
 * and the commit that mounts its Editor, nothing is focused, and focus recovery would otherwise read that as a loss and
 * paint a focus ring on the new Document tab.
 */
describe('pending Editor intent', () => {
    it('reports nothing outstanding once the queued intent reaches its Editor', () => {
        focusEditor('/project/pending-focus.ts');
        expect(hasPendingEditorIntent()).toBe(true);

        const mounted = editor();
        mount('/project/pending-focus.ts', mounted);
        expect(hasPendingEditorIntent()).toBe(false);
    });

    it('covers a queued navigation, which also ends in focus', () => {
        queueEditorNavigation('/project/pending-navigation.ts', {
            mode: 'caret',
            line: 3,
            column: 1,
        });
        expect(hasPendingEditorIntent()).toBe(true);

        const mounted = editor();
        mount('/project/pending-navigation.ts', mounted);
        expect(hasPendingEditorIntent()).toBe(false);
    });

    it('expires so an Editor that never mounts cannot disable focus recovery for the session', () => {
        focusEditor('/project/never-mounts.ts');
        expect(hasPendingEditorIntent(Date.now() + 1_999)).toBe(true);
        expect(hasPendingEditorIntent(Date.now() + 2_001)).toBe(false);
    });
});
