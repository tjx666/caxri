import { describe, expect, it, vi } from 'vitest';

import { didNavigateDiffEditor, getDiffEditorActionState } from '../diff-actions';
import type { SingleDiffKind } from '../single-diff-binding';
import { bindSingleDiffEditor } from '../single-diff-binding';

interface FakeSingleDiffEditor {
    contentListenerCount: () => number;
    decorationClear: ReturnType<typeof vi.fn>;
    decorationSet: ReturnType<typeof vi.fn>;
    editor: Parameters<typeof bindSingleDiffEditor>[0];
    emitContent: (value: string) => void;
    emitModelChange: (value: string) => void;
    focus: ReturnType<typeof vi.fn>;
    listenerCount: () => number;
    revealLineInCenter: ReturnType<typeof vi.fn>;
    setPosition: ReturnType<typeof vi.fn>;
}

function fakeSingleDiffEditor(initialValue: string): FakeSingleDiffEditor {
    let value = initialValue;
    const contentListeners = new Set<() => void>();
    const modelListeners = new Set<() => void>();
    const sizeListeners = new Set<() => void>();
    const decorationSet = vi.fn();
    const decorationClear = vi.fn();
    const setPosition = vi.fn();
    const revealLineInCenter = vi.fn();
    const focus = vi.fn();
    const lines = (): string[] => value.split(/\r\n|\r|\n/);
    const disposableListener = (listeners: Set<() => void>, listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
    };
    const editor = {
        createDecorationsCollection: () => ({ clear: decorationClear, set: decorationSet }),
        focus,
        getContentHeight: () => 120,
        getLayoutInfo: () => ({ horizontalScrollbarHeight: 10 }),
        getModel: () => ({
            getLineContent: (lineNumber: number) => lines()[lineNumber - 1] ?? '',
            getLineCount: () => lines().length,
            getValueLength: () => value.length,
        }),
        onDidChangeModel: (listener: () => void) => disposableListener(modelListeners, listener),
        onDidChangeModelContent: (listener: () => void) =>
            disposableListener(contentListeners, listener),
        onDidContentSizeChange: (listener: () => void) =>
            disposableListener(sizeListeners, listener),
        revealLineInCenter,
        setPosition,
    } as unknown as Parameters<typeof bindSingleDiffEditor>[0];

    return {
        contentListenerCount: () => contentListeners.size,
        decorationClear,
        decorationSet,
        editor,
        emitContent: (nextValue) => {
            value = nextValue;
            for (const listener of contentListeners) listener();
        },
        emitModelChange: (nextValue) => {
            value = nextValue;
            for (const listener of modelListeners) listener();
        },
        focus,
        listenerCount: () => contentListeners.size + modelListeners.size + sizeListeners.size,
        revealLineInCenter,
        setPosition,
    };
}

function lastDecorationRange(fake: FakeSingleDiffEditor): unknown {
    const decorations = fake.decorationSet.mock.lastCall?.[0] as
        Array<{ range: unknown }> | undefined;
    return decorations?.[0]?.range;
}

describe('single-sided Git diff editor binding', () => {
    it.each<SingleDiffKind>(['added', 'deleted'])(
        'navigates the all-%s document as one wrapping hunk through the public registry',
        (kind) => {
            const fake = fakeSingleDiffEditor('first\nsecond\n');
            const dispose = bindSingleDiffEditor(fake.editor, kind, {
                editorInstanceId: 'pane-1',
                navigationKey: `/diff/${kind}`,
            });

            expect(getDiffEditorActionState(`/diff/${kind}`, 'pane-1')).toEqual({
                hasChanges: true,
            });
            expect(fake.decorationSet.mock.lastCall?.[0]).toEqual([
                expect.objectContaining({
                    options: {
                        isWholeLine: true,
                        className: `git-${kind}-line`,
                        marginClassName: `git-${kind}-line`,
                        linesDecorationsClassName: `git-${kind}-indicator`,
                    },
                }),
            ]);
            expect(didNavigateDiffEditor(`/diff/${kind}`, 'pane-1', 'next')).toBe(true);
            expect(didNavigateDiffEditor(`/diff/${kind}`, 'pane-1', 'previous')).toBe(true);
            expect(fake.setPosition).toHaveBeenNthCalledWith(1, { lineNumber: 1, column: 1 });
            expect(fake.setPosition).toHaveBeenNthCalledWith(2, { lineNumber: 1, column: 1 });
            expect(fake.revealLineInCenter).toHaveBeenCalledTimes(2);
            expect(fake.focus).toHaveBeenCalledTimes(2);

            dispose();
        },
    );

    it.each([
        { content: 'alpha\n', endLineNumber: 1, label: 'LF-terminated content' },
        { content: 'alpha\r\n', endLineNumber: 1, label: 'CRLF-terminated content' },
        { content: '\n', endLineNumber: 1, label: 'an actual empty LF line' },
        { content: '\r\n', endLineNumber: 1, label: 'an actual empty CRLF line' },
        { content: 'alpha\n\n \nomega', endLineNumber: 4, label: 'empty and whitespace lines' },
        { content: 'alpha\r\n\r\n \r\nomega', endLineNumber: 4, label: 'CRLF empty lines' },
        {
            content: 'alpha\r\nomega',
            endLineNumber: 2,
            label: 'CRLF content without final newline',
        },
    ])(
        'decorates every changed line for $label without a phantom EOF line',
        ({ content, endLineNumber }) => {
            const fake = fakeSingleDiffEditor(content);
            const dispose = bindSingleDiffEditor(fake.editor, 'added', {});

            expect(lastDecorationRange(fake)).toEqual({
                startLineNumber: 1,
                startColumn: 1,
                endLineNumber,
                endColumn: 1,
            });

            dispose();
        },
    );

    it('redraws changed lines and disables navigation when updated content becomes empty', () => {
        const fake = fakeSingleDiffEditor('before\n');
        const dispose = bindSingleDiffEditor(fake.editor, 'deleted', {
            editorInstanceId: 'pane-1',
            navigationKey: '/diff/updated',
        });

        fake.emitContent('after\n\nlast');
        expect(lastDecorationRange(fake)).toMatchObject({ endLineNumber: 3 });
        expect(getDiffEditorActionState('/diff/updated', 'pane-1')).toEqual({ hasChanges: true });

        fake.emitContent('');
        expect(fake.decorationSet.mock.lastCall?.[0]).toEqual([]);
        expect(getDiffEditorActionState('/diff/updated', 'pane-1')).toEqual({ hasChanges: false });
        expect(didNavigateDiffEditor('/diff/updated', 'pane-1', 'next')).toBe(false);

        fake.emitModelChange('replacement');
        expect(lastDecorationRange(fake)).toMatchObject({ endLineNumber: 1 });
        expect(getDiffEditorActionState('/diff/updated', 'pane-1')).toEqual({ hasChanges: true });

        dispose();
    });

    it('cleans listeners, decorations, and only its own registry registration', () => {
        const first = fakeSingleDiffEditor('first');
        const replacement = fakeSingleDiffEditor('replacement');
        const split = fakeSingleDiffEditor('split');
        const disposeFirst = bindSingleDiffEditor(first.editor, 'added', {
            editorInstanceId: 'pane-1',
            navigationKey: '/diff/shared',
        });
        const disposeReplacement = bindSingleDiffEditor(replacement.editor, 'deleted', {
            editorInstanceId: 'pane-1',
            navigationKey: '/diff/shared',
        });
        const disposeSplit = bindSingleDiffEditor(split.editor, 'added', {
            editorInstanceId: 'pane-2',
            navigationKey: '/diff/shared',
        });

        expect(first.contentListenerCount()).toBe(1);
        expect(replacement.contentListenerCount()).toBe(2);
        disposeFirst();

        expect(first.listenerCount()).toBe(0);
        expect(first.decorationClear).toHaveBeenCalledOnce();
        expect(didNavigateDiffEditor('/diff/shared', 'pane-1', 'next')).toBe(true);
        expect(replacement.setPosition).toHaveBeenCalledOnce();
        expect(didNavigateDiffEditor('/diff/shared', 'pane-2', 'next')).toBe(true);
        expect(split.setPosition).toHaveBeenCalledOnce();

        const replacementDecorationCalls = replacement.decorationSet.mock.calls.length;
        disposeReplacement();
        expect(replacement.listenerCount()).toBe(0);
        expect(replacement.decorationClear).toHaveBeenCalledOnce();
        replacement.emitContent('ignored');
        expect(replacement.decorationSet).toHaveBeenCalledTimes(replacementDecorationCalls);
        expect(didNavigateDiffEditor('/diff/shared', 'pane-1', 'next')).toBe(false);
        expect(didNavigateDiffEditor('/diff/shared', 'pane-2', 'previous')).toBe(true);

        disposeSplit();
        expect(split.listenerCount()).toBe(0);
        expect(split.decorationClear).toHaveBeenCalledOnce();
        expect(didNavigateDiffEditor('/diff/shared', 'pane-2', 'next')).toBe(false);
    });
});
