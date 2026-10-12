import type { PaneTab } from '@caxri/protocol';
import { externalEditorTabPath, filePreviewTabPath, gitFileDiffTabPath } from '@caxri/protocol';
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

const {
    activePreviewSourcePath,
    canOpenActivePreview,
    openFilePreview,
    openFilePreviewToSide,
    previewSourcePath,
    previewTabSwitch,
} = await import('../preview-commands');

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

describe('previewSourcePath', () => {
    it('names an ordinary document a previewer claims', () => {
        expect(previewSourcePath('/p/README.md')).toBe('/p/README.md');
        expect(previewSourcePath('/p/badge.svg')).toBe('/p/badge.svg');
    });

    it('resolves a preview tab back to its source', () => {
        expect(previewSourcePath(filePreviewTabPath('/p/README.md'))).toBe('/p/README.md');
    });

    it('offers nothing for a file no previewer claims', () => {
        expect(previewSourcePath('/p/src/index.ts')).toBeUndefined();
    });

    it('offers nothing for another virtual tab that happens to end in a previewable extension', () => {
        expect(previewSourcePath(gitFileDiffTabPath('repo-1', '/p/README.md'))).toBeUndefined();
    });

    it('previews an external Markdown document from its cached buffer, and nothing else external', () => {
        const external = externalEditorTabPath('doc-1', '接入说明.md');

        expect(previewSourcePath(external)).toBe(external);
        expect(previewSourcePath(filePreviewTabPath(external))).toBe(external);
        expect(previewSourcePath(externalEditorTabPath('doc-2', 'badge.svg'))).toBeUndefined();
        expect(previewSourcePath(externalEditorTabPath('doc-3', 'notes.txt'))).toBeUndefined();
    });
});

describe('previewTabSwitch', () => {
    it('offers the preview from a source tab and the source from a preview tab', () => {
        expect(previewTabSwitch('/p/README.md')).toEqual({
            kind: 'openPreview',
            path: '/p/README.md',
        });
        expect(previewTabSwitch(filePreviewTabPath('/p/README.md'))).toEqual({
            kind: 'openSource',
            path: '/p/README.md',
        });
    });

    it('offers no source for a PDF, whose source would reopen the same preview', () => {
        expect(previewTabSwitch(filePreviewTabPath('/p/manual.pdf'))).toBeUndefined();
    });

    it('offers nothing for a file no previewer claims', () => {
        expect(previewTabSwitch('/p/src/index.ts')).toBeUndefined();
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
