import type { BootstrapState, SessionRecord, TerminalRecord } from '@caxri/protocol';
import {
    agentTranscriptTabPath,
    createPaneLayout,
    gitChangesDiffTabPath,
    gitCommitFileDiffTabPath,
    gitFileDiffTabPath,
    gitPullRequestFileDiffTabPath,
} from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    activateTerminal: vi.fn(),
    appendToAgentChatDraft: vi.fn(),
    focusTerminalById: vi.fn(),
    getActivePaneId: vi.fn<() => string | undefined>(),
    getActivePaneTab: vi.fn(),
    getBootstrap: vi.fn<() => BootstrapState | undefined>(),
    getDiffEditorFileSelection: vi.fn(),
    getQueryData: vi.fn(),
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
vi.mock('../../agent-chat/composer-input/agent-chat-drafts', () => ({
    appendToAgentChatDraft: mocks.appendToAgentChatDraft,
    draftWithInlineText: (draft: string, text: string) => `${draft}${text}`,
}));
vi.mock('../../terminal/terminal-commands', () => ({
    activateTerminal: mocks.activateTerminal,
    sendTerminalSequence: mocks.sendTerminalSequence,
}));
vi.mock('../../terminal/terminal-pane-handlers', () => ({
    focusTerminalById: mocks.focusTerminalById,
    whenTerminalAttached: mocks.whenTerminalAttached,
}));
vi.mock('../../workbench/pane-actions', () => ({
    getActivePaneId: mocks.getActivePaneId,
    getActivePaneTab: mocks.getActivePaneTab,
}));
vi.mock('../git-diff-actions', () => ({
    getDiffEditorFileSelection: mocks.getDiffEditorFileSelection,
}));
vi.mock('../../../queries/client', () => ({
    caxriQueryKey: (method: string, parameters: unknown) => [method, parameters],
    queryClient: { getQueryData: mocks.getQueryData },
}));

const { editorStatusKey, useEditorStatusStore } = await import('../editor-status');
const { canSendActiveFileReference, sendActiveFileReference } =
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

describe('sendActiveFileReference', () => {
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

        await sendActiveFileReference();

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

        await sendActiveFileReference();

        expect(mocks.sendTerminalSequence).toHaveBeenCalledWith(
            'terminal-1',
            '@src/index.ts#L3-L9 ',
        );
    });

    it('appends the reference to an Agent Chat draft instead of typing into its PTY', async () => {
        const chat = { ...terminal, id: 'chat-1', surface: 'chat' } as TerminalRecord;
        mocks.getBootstrap.mockReturnValue({ terminals: [chat] } as BootstrapState);

        await sendActiveFileReference();

        expect(mocks.appendToAgentChatDraft).toHaveBeenCalledWith(
            'chat-1',
            '@src/index.ts#L1 ',
            expect.any(Function),
        );
        expect(mocks.activateTerminal).toHaveBeenCalledWith('chat-1');
        expect(mocks.focusTerminalById).toHaveBeenCalledWith('chat-1');
        expect(mocks.sendTerminalSequence).not.toHaveBeenCalled();
        expect(mocks.whenTerminalAttached).not.toHaveBeenCalled();
    });

    it('falls back to line 1 before the editor has published a cursor', async () => {
        await sendActiveFileReference();

        expect(mocks.sendTerminalSequence).toHaveBeenCalledWith('terminal-1', '@src/index.ts#L1 ');
    });

    it('reports instead of writing when the revealed Terminal never attaches', async () => {
        mocks.whenTerminalAttached.mockResolvedValue(false);

        await sendActiveFileReference();

        expect(mocks.sendTerminalSequence).not.toHaveBeenCalled();
        expect(mocks.focusTerminalById).not.toHaveBeenCalled();
        expect(mocks.pushToast).toHaveBeenCalledWith('error', 'Terminal is not ready for input');
    });

    it('reports when the Session has no Terminal', async () => {
        mocks.getBootstrap.mockReturnValue({ terminals: [] } as unknown as BootstrapState);

        expect(canSendActiveFileReference()).toBe(false);
        await sendActiveFileReference();

        expect(mocks.activateTerminal).not.toHaveBeenCalled();
        expect(mocks.pushToast).toHaveBeenCalledWith(
            'error',
            'Open a Terminal in this Session first',
        );
    });

    it('ignores non-file tabs and virtual tabs that are not a Git diff', async () => {
        mocks.getActivePaneTab.mockReturnValue({
            id: 'tab-2',
            resource: { kind: 'terminal', terminalId: 'terminal-1' },
        });

        expect(canSendActiveFileReference()).toBe(false);
        await sendActiveFileReference();

        activeFile(agentTranscriptTabPath('terminal-1'));

        expect(canSendActiveFileReference()).toBe(false);
        await sendActiveFileReference();

        expect(mocks.sendTerminalSequence).not.toHaveBeenCalled();
    });
});

describe('sendActiveFileReference from a Git diff tab', () => {
    const diffTabPath = gitFileDiffTabPath('repo-1', 'src/index.ts');

    beforeEach(() => {
        vi.clearAllMocks();
        useEditorStatusStore.setState({ statuses: {} });
        mocks.getSelectedSession.mockReturnValue(session);
        mocks.getBootstrap.mockReturnValue({ terminals: [terminal] } as BootstrapState);
        mocks.getSessionState.mockReturnValue({
            paneLayout: createPaneLayout({ kind: 'file', path: diffTabPath }),
        });
        mocks.selectSelectedWorkbenchProject.mockReturnValue({ rootPath: '/repo' });
        mocks.whenTerminalAttached.mockResolvedValue(true);
        mocks.getActivePaneId.mockReturnValue('pane-1');
        mocks.getQueryData.mockReturnValue({
            isRepository: true,
            repositories: [{ id: 'repo-1', rootPath: '/repo', files: [] }],
        });
        activeFile(diffTabPath);
    });

    it('references the diff editor caret against the repository file', async () => {
        mocks.getDiffEditorFileSelection.mockReturnValue({
            line: 1251,
            column: 7,
            selectionStartLine: 1251,
            selectionEndLine: 1251,
        });

        expect(canSendActiveFileReference()).toBe(true);
        await sendActiveFileReference();

        expect(mocks.getDiffEditorFileSelection).toHaveBeenCalledWith(diffTabPath, 'pane-1');
        expect(mocks.sendTerminalSequence).toHaveBeenCalledWith(
            'terminal-1',
            '@src/index.ts#L1251 ',
        );
    });

    it('keeps the selected line span of a multi-line diff selection', async () => {
        mocks.getDiffEditorFileSelection.mockReturnValue({
            line: 9,
            column: 1,
            selectionStartLine: 3,
            selectionEndLine: 8,
        });

        await sendActiveFileReference();

        expect(mocks.sendTerminalSequence).toHaveBeenCalledWith(
            'terminal-1',
            '@src/index.ts#L3-L8 ',
        );
    });

    it('falls back to line 1 while the diff editor has no caret yet', async () => {
        mocks.getDiffEditorFileSelection.mockReturnValue(undefined);

        await sendActiveFileReference();

        expect(mocks.sendTerminalSequence).toHaveBeenCalledWith('terminal-1', '@src/index.ts#L1 ');
    });

    it('declines a file the working tree no longer has', async () => {
        mocks.getQueryData.mockReturnValue({
            isRepository: true,
            repositories: [
                {
                    id: 'repo-1',
                    rootPath: '/repo',
                    files: [{ path: 'src/index.ts', kind: 'deleted' }],
                },
            ],
        });

        expect(canSendActiveFileReference()).toBe(false);
        await sendActiveFileReference();

        expect(mocks.sendTerminalSequence).not.toHaveBeenCalled();
    });

    it('declines when the repository root is unknown', async () => {
        mocks.getQueryData.mockReturnValue(undefined);

        expect(canSendActiveFileReference()).toBe(false);
        await sendActiveFileReference();

        expect(mocks.sendTerminalSequence).not.toHaveBeenCalled();
    });

    it('declines a multi-file changes tab, which names no single file', async () => {
        activeFile(gitChangesDiffTabPath('repo-1', 'repo'));

        expect(canSendActiveFileReference()).toBe(false);
        await sendActiveFileReference();

        expect(mocks.sendTerminalSequence).not.toHaveBeenCalled();
    });

    it('references the caret line of a commit or pull-request comparison too', async () => {
        // These render a past revision, so the line can address different code in the checkout. Issue #1147 chose the
        // reference anyway: a reader asking about the line in front of them is better served by one that may need
        // adjusting than by a shortcut that silently does nothing.
        mocks.getDiffEditorFileSelection.mockReturnValue({
            line: 42,
            column: 1,
            selectionStartLine: 42,
            selectionEndLine: 42,
        });

        const expectReference = async (path: string): Promise<void> => {
            activeFile(path);
            expect(canSendActiveFileReference()).toBe(true);
            await sendActiveFileReference();
            expect(mocks.sendTerminalSequence).toHaveBeenLastCalledWith(
                'terminal-1',
                '@src/index.ts#L42 ',
            );
        };

        await expectReference(gitCommitFileDiffTabPath('repo-1', 'a'.repeat(40), 'src/index.ts'));
        await expectReference(gitPullRequestFileDiffTabPath('repo-1', 'src/index.ts'));
    });
});
