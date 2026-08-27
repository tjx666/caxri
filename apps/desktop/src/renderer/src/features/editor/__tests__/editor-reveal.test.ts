import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
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

function mount(path: string, mounted: ReturnType<typeof editor>): void {
    const unregister = registerEditorRevealTarget(
        path,
        mounted as unknown as Parameters<typeof registerEditorRevealTarget>[1],
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
        expect(mounted.revealLineInCenter).toHaveBeenCalledWith(20);
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
});
