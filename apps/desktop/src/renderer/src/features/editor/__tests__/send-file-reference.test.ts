import type { BootstrapState, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { createPaneLayout } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    activateTerminal: vi.fn(),
    focusTerminalById: vi.fn(),
    getActivePaneTab: vi.fn(),
    getBootstrap: vi.fn<() => BootstrapState | undefined>(),
    getSelectedSession: vi.fn<() => SessionRecord | undefined>(),
    getSessionState: vi.fn(),
    pushToast: vi.fn(),
    selectSelectedWorkbenchProject: vi.fn(),
    sendTerminalSequence: vi.fn(),
    sessionViewScope: vi.fn((sessionId: string) => sessionId),
    whenTerminalAttached: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('../../../stores/selectors', () => ({
    getBootstrap: mocks.getBootstrap,
    getSelectedSession: mocks.getSelectedSession,
    getSessionState: mocks.getSessionState,
    selectSelectedWorkbenchProject: mocks.selectSelectedWorkbenchProject,
}));
vi.mock('../../../stores/session-view', () => ({ sessionViewScope: mocks.sessionViewScope }));
vi.mock('../../../stores/toasts', () => ({ pushToast: mocks.pushToast }));
vi.mock('../../terminal/terminal-commands', () => ({
    activateTerminal: mocks.activateTerminal,
    focusTerminalById: mocks.focusTerminalById,
    sendTerminalSequence: mocks.sendTerminalSequence,
    whenTerminalAttached: mocks.whenTerminalAttached,
}));
vi.mock('../../workbench/pane-actions', () => ({ getActivePaneTab: mocks.getActivePaneTab }));

const { editorStatusKey, useEditorStatusStore } = await import('../editor-status');
const { canSendActiveFileReference, sendActiveFileReferenceToTerminal } =
    await import('../send-file-reference');

const session = { id: 'session-1', projectId: 'project-1' } as SessionRecord;
const terminal = {
    id: 'terminal-1',
    sessionId: 'session-1',
    createdAt: 1,
    orderIndex: 0,
} as TerminalRecord;

function activeFile(path: string): void {
    mocks.getActivePaneTab.mockReturnValue({ id: 'tab-1', resource: { kind: 'file', path } });
}

describe('sendActiveFileReferenceToTerminal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useEditorStatusStore.setState({ statuses: {} });
        mocks.getSelectedSession.mockReturnValue(session);
        mocks.getBootstrap.mockReturnValue({ terminals: [terminal] } as BootstrapState);
        mocks.getSessionState.mockReturnValue({
            paneLayout: createPaneLayout({ kind: 'file', path: '/repo/src/index.ts' }),
        });
        mocks.selectSelectedWorkbenchProject.mockReturnValue({ rootPath: '/repo' });
        mocks.whenTerminalAttached.mockResolvedValue(true);
        activeFile('/repo/src/index.ts');
    });

    it('reveals the Terminal, waits for its attachment, then types the cursor reference and focuses it', async () => {
        useEditorStatusStore
            .getState()
            .setStatus(editorStatusKey('session-1', '/repo/src/index.ts'), {
                line: 12,
                column: 3,
                selectionStartLine: 12,
                selectionEndLine: 12,
                selectedCharacters: 0,
                languageId: 'typescript',
            });

        await sendActiveFileReferenceToTerminal();

        expect(mocks.activateTerminal).toHaveBeenCalledWith('terminal-1');
        expect(mocks.whenTerminalAttached).toHaveBeenCalledWith('terminal-1', expect.any(Number));
        expect(mocks.activateTerminal.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.sendTerminalSequence.mock.invocationCallOrder[0],
        );
        expect(mocks.sendTerminalSequence).toHaveBeenCalledWith('terminal-1', '@src/index.ts#L12 ');
        expect(mocks.focusTerminalById).toHaveBeenCalledWith('terminal-1');
    });

    it('uses the selected line span when the editor reports one', async () => {
        useEditorStatusStore
            .getState()
            .setStatus(editorStatusKey('session-1', '/repo/src/index.ts'), {
                line: 9,
                column: 1,
                selectionStartLine: 3,
                selectionEndLine: 9,
                selectedCharacters: 120,
                languageId: 'typescript',
            });

        await sendActiveFileReferenceToTerminal();

        expect(mocks.sendTerminalSequence).toHaveBeenCalledWith(
            'terminal-1',
            '@src/index.ts#L3-L9 ',
        );
    });

    it('falls back to line 1 before the editor has published a cursor', async () => {
        await sendActiveFileReferenceToTerminal();

        expect(mocks.sendTerminalSequence).toHaveBeenCalledWith('terminal-1', '@src/index.ts#L1 ');
    });

    it('reports instead of writing when the revealed Terminal never attaches', async () => {
        mocks.whenTerminalAttached.mockResolvedValue(false);

        await sendActiveFileReferenceToTerminal();

        expect(mocks.sendTerminalSequence).not.toHaveBeenCalled();
        expect(mocks.focusTerminalById).not.toHaveBeenCalled();
        expect(mocks.pushToast).toHaveBeenCalledWith('error', 'Terminal is not ready for input');
    });

    it('reports when the Session has no Terminal', async () => {
        mocks.getBootstrap.mockReturnValue({ terminals: [] } as unknown as BootstrapState);

        expect(canSendActiveFileReference()).toBe(false);
        await sendActiveFileReferenceToTerminal();

        expect(mocks.activateTerminal).not.toHaveBeenCalled();
        expect(mocks.pushToast).toHaveBeenCalledWith(
            'error',
            'Open a Terminal in this Session first',
        );
    });

    it('ignores virtual editor tabs and non-file tabs', async () => {
        mocks.getActivePaneTab.mockReturnValue({
            id: 'tab-2',
            resource: { kind: 'terminal', terminalId: 'terminal-1' },
        });

        expect(canSendActiveFileReference()).toBe(false);
        await sendActiveFileReferenceToTerminal();

        expect(mocks.sendTerminalSequence).not.toHaveBeenCalled();
    });
});
