import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    archiveSession: vi.fn(),
    closeTerminal: vi.fn(),
    activeTab: undefined as { id: string; resource: unknown } | undefined,
    closeDocumentTabFamily: vi.fn(),
    paneLayout: undefined as unknown,
}));

/**
 * See `execute-diagnostics.test.ts`: Monaco needs a real `window`, which this suite's `node` environment lacks.
 */
vi.mock('../features/editor/git-review-comment-binding', () => ({
    listBoundGitReviewCommentEditors: () => new Set(),
}));
vi.mock('../features/editor/document-commands', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    closeDocumentTabFamily: mocks.closeDocumentTabFamily,
}));
vi.mock('../features/session/session-archive-commands', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    archiveSession: mocks.archiveSession,
}));
vi.mock('../features/terminal/terminal-commands', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    closeTerminal: mocks.closeTerminal,
}));
vi.mock('../features/workbench/pane-actions', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getActivePaneTab: () => mocks.activeTab,
    getPaneLayout: () => mocks.paneLayout,
}));

import { executeCommand, isCommandAvailable } from './execute';

/**
 * Cmd+W and Close Terminal act on a pane tab, never on the Session: closing the last pane tab leaves the Session open
 * and empty, and archiving stays an explicit command (`session.archive`).
 */
describe('closing the last pane tab', () => {
    beforeEach(() => {
        mocks.archiveSession.mockReset();
        mocks.closeTerminal.mockReset();
        mocks.activeTab = { id: 'tab-1', resource: { kind: 'terminal', terminalId: 'terminal-1' } };
    });

    it('closes the Terminal without archiving its Session on workbench.closeActiveTab', () => {
        executeCommand('workbench.closeActiveTab');

        expect(mocks.closeTerminal).toHaveBeenCalledWith('terminal-1');
        expect(mocks.archiveSession).not.toHaveBeenCalled();
    });

    it('closes the Terminal without archiving its Session on terminal.close', () => {
        executeCommand('terminal.close');

        expect(mocks.closeTerminal).toHaveBeenCalledWith('terminal-1');
        expect(mocks.archiveSession).not.toHaveBeenCalled();
    });
});

const terminalTab = { id: 'tab-1', resource: { kind: 'terminal', terminalId: 'terminal-1' } };
const fileTab = { id: 'tab-2', resource: { kind: 'file', path: 'a.ts' } };

function paneWith(tabs: unknown[]) {
    return {
        root: { type: 'pane', id: 'pane-1', tabs, activeTabId: 'tab-1' },
        activePaneId: 'pane-1',
    };
}

/**
 * `Cmd+K Cmd+W` is the keyboard form of the tab menu's Close Others, so it resolves through the same close family.
 */
describe('closing the other tabs', () => {
    beforeEach(() => {
        mocks.closeDocumentTabFamily.mockReset();
        mocks.closeDocumentTabFamily.mockResolvedValue(undefined);
        mocks.activeTab = terminalTab;
        mocks.paneLayout = paneWith([terminalTab, fileTab]);
    });

    it("closes the active pane's other tabs through the Close Others family", () => {
        executeCommand('workbench.closeOtherTabs');

        expect(mocks.closeDocumentTabFamily).toHaveBeenCalledWith('tab-1', 'others');
    });

    it('is unavailable when the active tab is alone in its pane', () => {
        mocks.paneLayout = paneWith([terminalTab]);

        expect(isCommandAvailable('workbench.closeOtherTabs')).toBe(false);
    });
});
