import type { PaneTab } from '@caxri/protocol';
import { filePreviewTabPath } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    activeTab: undefined as PaneTab | undefined,
    openEditorTab: vi.fn(),
    splitPaneTab: vi.fn(),
    findPaneTabId: vi.fn(() => 'tab-preview'),
    getActivePaneId: vi.fn(() => 'pane-1'),
}));

vi.mock('../../editor/document-commands', () => ({ openEditorTab: mocks.openEditorTab }));
vi.mock('../../workbench/pane-actions', () => ({
    findPaneTabId: mocks.findPaneTabId,
    getActivePaneId: mocks.getActivePaneId,
    getActivePaneTab: () => mocks.activeTab,
    splitPaneTab: mocks.splitPaneTab,
}));

const { activePreviewSourcePath, canOpenActivePreview, openFilePreview, openFilePreviewToSide } =
    await import('../preview-commands');

function fileTab(path: string): PaneTab {
    return { id: 'tab-1', resource: { kind: 'file', path } };
}

describe('activePreviewSourcePath', () => {
    beforeEach(() => {
        mocks.activeTab = undefined;
        vi.clearAllMocks();
    });

    it('names the active document when a previewer claims it', () => {
        mocks.activeTab = fileTab('/p/README.md');

        expect(activePreviewSourcePath()).toBe('/p/README.md');
        expect(canOpenActivePreview()).toBe(true);
    });

    it('resolves back to the source when the preview itself is active', () => {
        mocks.activeTab = fileTab(filePreviewTabPath('/p/README.md'));

        expect(activePreviewSourcePath()).toBe('/p/README.md');
    });

    it('offers nothing for a file no previewer claims', () => {
        mocks.activeTab = fileTab('/p/src/index.ts');

        expect(canOpenActivePreview()).toBe(false);
    });

    it('offers nothing for a Terminal tab', () => {
        mocks.activeTab = { id: 'tab-2', resource: { kind: 'terminal', terminalId: 'terminal-1' } };

        expect(canOpenActivePreview()).toBe(false);
    });

    it('offers nothing for another virtual tab that happens to end in a previewable extension', () => {
        mocks.activeTab = fileTab('caxri-git-diff://file?path=%2Fp%2FREADME.md&ref=HEAD');

        expect(canOpenActivePreview()).toBe(false);
    });
});

describe('openFilePreview', () => {
    beforeEach(() => vi.clearAllMocks());

    it('opens the preview tab for its source document', () => {
        openFilePreview('/p/README.md');

        expect(mocks.openEditorTab).toHaveBeenCalledWith(filePreviewTabPath('/p/README.md'));
    });

    it('refuses a file no previewer claims', () => {
        openFilePreview('/p/src/index.ts');

        expect(mocks.openEditorTab).not.toHaveBeenCalled();
    });

    it('splits the new tab off the active pane when opening to the side', () => {
        openFilePreviewToSide('/p/README.md');

        expect(mocks.openEditorTab).toHaveBeenCalledWith(filePreviewTabPath('/p/README.md'));
        expect(mocks.splitPaneTab).toHaveBeenCalledWith('tab-preview', 'pane-1', 'right');
    });

    it('leaves the preview in place when the layout did not produce a tab to split', () => {
        mocks.findPaneTabId.mockReturnValueOnce(undefined as unknown as string);

        openFilePreviewToSide('/p/README.md');

        expect(mocks.splitPaneTab).not.toHaveBeenCalled();
    });
});
