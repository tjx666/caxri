import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    archiveSession: vi.fn(),
    closeTerminal: vi.fn(),
    activeTab: undefined as { id: string; resource: unknown } | undefined,
}));

/**
 * See `execute-diagnostics.test.ts`: Monaco needs a real `window`, which this suite's `node` environment lacks.
 */
vi.mock('../features/editor/git-review-comment-binding', () => ({
    listBoundGitReviewCommentEditors: () => new Set(),
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
}));

import { executeCommand } from './execute';

/**
 * Cmd+W and Close Terminal act on a pane tab, never on the Session: closing the last pane tab leaves the Session open
 * and empty, and archiving stays an explicit command (`session.archive`). The Open Session level has its own command,
 * `session.closeTab`, covered in `execute.test.ts`.
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
