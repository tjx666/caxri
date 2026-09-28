import { afterEach, describe, expect, it, vi } from 'vitest';

// `editor-loader.ts` dynamically imports both modules; `vi.mock` intercepts them regardless of
// whether the import is static or dynamic as long as the specifiers resolve to the same module.
const mocks = vi.hoisted(() => ({
    warmMonacoEditor: vi.fn(() => Promise.resolve()),
}));

vi.mock('../code-editor', () => ({
    CodeEditor: function StubCodeEditor(): null {
        return null;
    },
}));

vi.mock('../../../lib/monaco', () => ({
    warmMonacoEditor: mocks.warmMonacoEditor,
}));

describe('editor-loader', () => {
    // The default Vitest environment is `node` (see vitest.config.ts); `editor-loader.ts` only
    // touches `window.setTimeout`/`clearTimeout` as its `requestIdleCallback` fallback, so aliasing
    // `window` to `globalThis` is enough without pulling in a DOM environment dependency.
    vi.stubGlobal('window', globalThis);

    afterEach(() => {
        vi.resetModules();
        mocks.warmMonacoEditor.mockClear();
    });

    it('still warms Monaco when a user load races ahead of the idle preload', async () => {
        const { loadCodeEditor, scheduleCodeEditorPreload } = await import('../editor-loader');

        // Regression for the bug where `loadCodeEditor()` firing before the idle preload callback
        // permanently disabled warm-up for the rest of the app session (see commit 87341c3's intent:
        // a user-initiated load must not block on warm-up, but warm-up must still eventually run).
        await loadCodeEditor();
        expect(mocks.warmMonacoEditor).not.toHaveBeenCalled();

        // Simulate the idle callback firing after the user load already happened.
        const cancel = scheduleCodeEditorPreload();
        await vi.waitFor(() => expect(mocks.warmMonacoEditor).toHaveBeenCalledTimes(1));
        cancel();
    });

    it('warms Monaco once when the idle preload runs before any user load', async () => {
        const { scheduleCodeEditorPreload } = await import('../editor-loader');

        const cancel = scheduleCodeEditorPreload();
        await vi.waitFor(() => expect(mocks.warmMonacoEditor).toHaveBeenCalledTimes(1));
        cancel();
    });

    it('notifies a later subscriber when an earlier one throws', async () => {
        const { loadCodeEditor, subscribeLoadedCodeEditor } = await import('../editor-loader');
        const failing = vi.fn(() => {
            throw new Error('editor loaded listener failure');
        });
        const surviving = vi.fn();
        subscribeLoadedCodeEditor(failing);
        subscribeLoadedCodeEditor(surviving);
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await loadCodeEditor();

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledTimes(1);
        vi.restoreAllMocks();
    });
});
