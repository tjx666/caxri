import { beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '../../../queries/client';
import type { ToastKind, ToastOptions } from '../../../stores/toasts';

const mocks = vi.hoisted(() => {
    const pushToast = vi.fn<(kind: ToastKind, message: string, options?: ToastOptions) => void>();
    return {
        askAgentForProject: vi.fn(),
        caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve([])),
        closeCreateSessionMenu: vi.fn(),
        dropSessions: vi.fn(),
        getBootstrap: vi.fn(),
        openCreateSessionMenu: vi.fn(),
        pendingProjectId: undefined as string | undefined,
        pendingRoot: undefined as string | undefined,
        primarySidebarVisible: true,
        setPrimarySidebarVisible: vi.fn(),
        getQueryData: vi.fn(),
        getSelectedSession: vi.fn(),
        openExternalUrl: vi.fn(() => Promise.resolve()),
        pushToast,
        registerSessionCommandConvergence: vi.fn(() => ({
            cancel: vi.fn(),
            promise: Promise.resolve(),
        })),
        refreshWorkbench: vi.fn(() => Promise.resolve()),
        removeSessionQueries: vi.fn(),
        selectSelectedProject: vi.fn(),
        /**
         * Mirrors the real funnel's swallow-and-report contract rather than only forwarding `run`: an action offered
         * inside a toast must survive its own request failing, which is unobservable when the double re-throws.
         */
        tryCommand: vi.fn(
            async (
                ...[label, run]: [
                    string,
                    () => Promise<unknown>,
                    { refresh?: () => Promise<void> }?,
                ]
            ): Promise<unknown> => {
                try {
                    return await run();
                } catch (error) {
                    pushToast('error', `${label}: ${(error as Error).message}`);
                    return undefined;
                }
            },
        ),
    };
});

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));
vi.mock('../../../lib/external-link', () => ({ openExternalUrl: mocks.openExternalUrl }));
vi.mock('../../../queries/client', () => ({
    caxriQueryKey: (method: string, parameters: unknown) => [method, parameters],
    queryClient: { getQueryData: mocks.getQueryData },
}));
vi.mock('../../../queries/invalidation', () => ({
    removeSessionQueries: mocks.removeSessionQueries,
}));
vi.mock('../../../stores/chrome-layout', () => ({
    useChromeLayoutStore: {
        getState: vi.fn(() => ({
            primarySidebarVisible: mocks.primarySidebarVisible,
            setPrimarySidebarVisible: mocks.setPrimarySidebarVisible,
        })),
    },
}));
vi.mock('../../../stores/dialogs', () => ({
    clearPendingSession: vi.fn(),
    useDialogStore: {
        getState: vi.fn(() => ({
            askAgentForProject: mocks.askAgentForProject,
            closeCreateSessionMenu: mocks.closeCreateSessionMenu,
            openCreateSessionMenu: mocks.openCreateSessionMenu,
            pendingProjectId: mocks.pendingProjectId,
            pendingRoot: mocks.pendingRoot,
        })),
    },
}));
vi.mock('../../../stores/selectors', () => ({
    getBootstrap: mocks.getBootstrap,
    getSelectedSession: mocks.getSelectedSession,
    selectSelectedProject: mocks.selectSelectedProject,
    selectSelectedSession: vi.fn(),
}));
vi.mock('../../../stores/session-view', () => ({
    useSessionViewStore: { getState: vi.fn(() => ({ dropSessions: mocks.dropSessions })) },
}));
vi.mock('../../../stores/toasts', () => ({
    pushToast: mocks.pushToast,
    tryCommand: mocks.tryCommand,
}));
vi.mock('../../../stores/workbench', () => ({
    registerSessionCommandConvergence: mocks.registerSessionCommandConvergence,
    refreshWorkbench: mocks.refreshWorkbench,
    useWorkbenchStore: { getState: () => ({ bootstrap: undefined }) },
}));

import {
    deleteSelectedSession,
    deleteSession,
    didReorderPinnedSession,
    didReorderProject,
    didReorderSession,
    didSelectSession,
    moveTerminalToNewSession,
    openProjectInExternalEditor,
    openSelectedProjectInExternalEditor,
    openSelectedSessionPullRequest,
    openSession,
    selectAdjacentSession,
    selectProject,
    setSessionPinned,
} from '../session-commands';

describe('Session actions', () => {
    beforeEach(() => {
        mocks.askAgentForProject.mockClear();
        mocks.caxriRequest.mockClear();
        mocks.pushToast.mockClear();
        mocks.dropSessions.mockClear();
        mocks.getBootstrap.mockReset();
        mocks.getQueryData.mockReset();
        mocks.getSelectedSession.mockReset();
        mocks.openExternalUrl.mockClear();
        mocks.pushToast.mockClear();
        mocks.registerSessionCommandConvergence.mockClear();
        mocks.refreshWorkbench.mockClear();
        mocks.removeSessionQueries.mockClear();
        mocks.selectSelectedProject.mockReset();
        mocks.tryCommand.mockClear();
        mocks.closeCreateSessionMenu.mockClear();
        mocks.openCreateSessionMenu.mockClear();
        mocks.setPrimarySidebarVisible.mockClear();
        mocks.pendingProjectId = undefined;
        mocks.pendingRoot = undefined;
        mocks.primarySidebarVisible = true;
    });

    it('opens the selected Session pull request from the sidebar snapshot without refetching', () => {
        mocks.getSelectedSession.mockReturnValue({ id: 'session-1' });
        mocks.getQueryData.mockReturnValue({
            pullRequests: {
                'session-1': { number: 42, url: 'https://github.com/tjx666/project/pull/42' },
            },
        });

        openSelectedSessionPullRequest();

        expect(mocks.getQueryData).toHaveBeenCalledWith(['session.pullRequests', undefined]);
        expect(mocks.openExternalUrl).toHaveBeenCalledWith(
            'https://github.com/tjx666/project/pull/42',
            expect.any(Function),
        );
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
    });

    it('is a silent no-op when the selected Session has no pull request', () => {
        mocks.getSelectedSession.mockReturnValue({ id: 'session-1' });
        mocks.getQueryData.mockReturnValue({ pullRequests: {} });

        openSelectedSessionPullRequest();

        expect(mocks.openExternalUrl).not.toHaveBeenCalled();
    });

    it('opens a Session in its current Workbench Project after it continues in a worktree', async () => {
        mocks.getBootstrap.mockReturnValue({
            projects: [
                { id: 'project-owner', rootPath: '/workspace/repository' },
                { id: 'project-worktree', rootPath: '/workspace/repository-worktree' },
            ],
            sessions: [
                {
                    id: 'session-1',
                    projectId: 'project-owner',
                    workbenchProjectId: 'project-worktree',
                },
            ],
            settings: {},
        });

        openProjectInExternalEditor(
            { id: 'project-owner', rootPath: '/workspace/repository' },
            'session-1',
        );
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('project.openInEditor', {
            path: '/workspace/repository-worktree',
            sessionId: 'session-1',
        });
    });

    it('opens a Project with no Session using only its stored identity', async () => {
        openProjectInExternalEditor({ id: 'project-owner', rootPath: '/workspace/repository' });
        await mocks.tryCommand.mock.results[0]?.value;
        expect(mocks.caxriRequest).toHaveBeenCalledWith('project.openRoot', {
            projectId: 'project-owner',
            application: 'editor',
        });
    });

    it('uses the selected Session Workbench Project for the global editor command', async () => {
        const owner = { id: 'project-owner', rootPath: '/workspace/repository' };
        mocks.getBootstrap.mockReturnValue({
            projects: [
                owner,
                { id: 'project-worktree', rootPath: '/workspace/repository-worktree' },
            ],
            sessions: [
                {
                    id: 'session-1',
                    projectId: 'project-owner',
                    workbenchProjectId: 'project-worktree',
                },
            ],
            settings: {},
        });
        mocks.selectSelectedProject.mockReturnValue(owner);
        mocks.getSelectedSession.mockReturnValue({ id: 'session-1', projectId: owner.id });

        openSelectedProjectInExternalEditor();
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('project.openInEditor', {
            path: '/workspace/repository-worktree',
            sessionId: 'session-1',
        });
    });

    it('does not start Session creation when a Project has no active Sessions', () => {
        mocks.getBootstrap.mockReturnValue({
            projects: [{ id: 'project-1' }],
            sessions: [
                {
                    archivedAt: Date.now(),
                    createdAt: 1,
                    id: 'session-1',
                    lastSessionActivityAt: 1,
                    projectId: 'project-1',
                },
            ],
            settings: {},
        });

        selectProject('project-1');

        expect(mocks.askAgentForProject).not.toHaveBeenCalled();
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
    });

    it('selects the most recently active Session when a Project is opened', async () => {
        mocks.getBootstrap.mockReturnValue({
            projects: [{ id: 'project-1' }],
            sessions: [
                {
                    createdAt: 1,
                    id: 'older',
                    lastSessionActivityAt: 10,
                    projectId: 'project-1',
                },
                {
                    createdAt: 2,
                    id: 'newer',
                    lastSessionActivityAt: 20,
                    projectId: 'project-1',
                },
            ],
            settings: {},
        });

        selectProject('project-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.select', {
            sessionId: 'newer',
        });
        expect(mocks.tryCommand.mock.calls[0]?.[2]).toBeUndefined();
    });

    it('registers and awaits event-driven convergence around a Session selection', async () => {
        const convergence = Promise.withResolvers<void>();
        const cancel = vi.fn();
        mocks.caxriRequest.mockResolvedValueOnce({ id: 'session-2' });
        mocks.registerSessionCommandConvergence.mockReturnValueOnce({
            cancel,
            promise: convergence.promise,
        });

        const selected = didSelectSession('session-2');
        await vi.waitFor(() => expect(mocks.caxriRequest).toHaveBeenCalledOnce());

        expect(mocks.registerSessionCommandConvergence.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.caxriRequest.mock.invocationCallOrder[0],
        );
        await expect(Promise.race([selected, Promise.resolve('pending')])).resolves.toBe('pending');

        convergence.resolve();
        await expect(selected).resolves.toBe(true);
        expect(cancel).not.toHaveBeenCalled();
    });

    it('keeps a relative reorder pending until its event-driven snapshot is applied', async () => {
        const convergence = Promise.withResolvers<void>();
        const cancel = vi.fn();
        mocks.caxriRequest.mockResolvedValueOnce(null);
        mocks.registerSessionCommandConvergence.mockReturnValueOnce({
            cancel,
            promise: convergence.promise,
        });
        const reordered = didReorderSession('session-1', 'session-2', 'after');
        await vi.waitFor(() =>
            expect(mocks.caxriRequest).toHaveBeenCalledWith('session.reorder', {
                sessionId: 'session-1',
                anchorSessionId: 'session-2',
                placement: 'after',
            }),
        );
        expect(mocks.registerSessionCommandConvergence).toHaveBeenCalledWith('session.reorder');
        await expect(Promise.race([reordered, Promise.resolve('pending')])).resolves.toBe(
            'pending',
        );
        convergence.resolve();
        await expect(reordered).resolves.toBe(true);
        expect(mocks.refreshWorkbench).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
    });

    it('holds a Pinned reorder on its own convergence reason and its own Server method', async () => {
        const convergence = Promise.withResolvers<void>();
        const cancel = vi.fn();
        mocks.caxriRequest.mockResolvedValueOnce(null);
        mocks.registerSessionCommandConvergence.mockReturnValueOnce({
            cancel,
            promise: convergence.promise,
        });
        const reordered = didReorderPinnedSession('session-1', 'session-2', 'before');
        await vi.waitFor(() =>
            expect(mocks.caxriRequest).toHaveBeenCalledWith('session.reorderPinned', {
                sessionId: 'session-1',
                anchorSessionId: 'session-2',
                placement: 'before',
            }),
        );
        // A Pinned drag must not converge on the Project groups' reason, or one drag would release the other's wait.
        expect(mocks.registerSessionCommandConvergence).toHaveBeenCalledWith(
            'session.reorderPinned',
        );
        await expect(Promise.race([reordered, Promise.resolve('pending')])).resolves.toBe(
            'pending',
        );
        convergence.resolve();
        await expect(reordered).resolves.toBe(true);
        expect(cancel).not.toHaveBeenCalled();
    });

    it.each([
        { name: 'a Project', reorder: didReorderSession },
        { name: 'the Pinned group', reorder: didReorderPinnedSession },
    ])('cancels the snapshot waiter when a reorder in $name fails', async ({ reorder }) => {
        const cancel = vi.fn();
        mocks.registerSessionCommandConvergence.mockReturnValueOnce({
            cancel,
            promise: new Promise(() => {}),
        });
        mocks.tryCommand.mockResolvedValueOnce(undefined);
        await expect(reorder('session-1', 'missing', 'before')).resolves.toBe(false);
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('sends the pin state and refreshes, with its own failure copy per direction', async () => {
        const expectPinCommand = (failureTitle: string) =>
            expect(mocks.tryCommand).toHaveBeenCalledWith(failureTitle, expect.any(Function), {
                refresh: mocks.refreshWorkbench,
            });
        setSessionPinned('session-1', true);
        await vi.waitFor(() =>
            expect(mocks.caxriRequest).toHaveBeenCalledWith('session.setPinned', {
                sessionId: 'session-1',
                pinned: true,
            }),
        );
        // Unlike a reorder this waits for no snapshot, so the refresh is what puts the new row on screen.
        expectPinCommand('Pin Session failed');
        setSessionPinned('session-1', false);
        await vi.waitFor(() => expectPinCommand('Unpin Session failed'));
    });

    it('walks adjacent Sessions in visible Project and activity order', async () => {
        mocks.getBootstrap.mockReturnValue({
            projects: [{ id: 'project-1' }, { id: 'project-2' }],
            sessions: [
                {
                    createdAt: 1,
                    id: 'project-1-older',
                    lastSessionActivityAt: 10,
                    projectId: 'project-1',
                },
                {
                    createdAt: 2,
                    id: 'project-2-newest',
                    lastSessionActivityAt: 100,
                    projectId: 'project-2',
                },
                {
                    createdAt: 3,
                    id: 'project-1-newer',
                    lastSessionActivityAt: 20,
                    projectId: 'project-1',
                },
            ],
            settings: {},
        });
        mocks.getSelectedSession.mockReturnValue({ id: 'project-1-older' });

        selectAdjacentSession(1);
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.select', {
            sessionId: 'project-2-newest',
        });
    });

    it('lets the Runtime full-state event be the sole Project reorder refresh', async () => {
        await expect(didReorderProject('project-1', 2)).resolves.toBe(true);

        expect(mocks.caxriRequest).toHaveBeenCalledWith('project.reorder', {
            projectId: 'project-1',
            targetIndex: 2,
        });
        expect(mocks.tryCommand.mock.calls[0]?.[2]).toBeUndefined();
    });

    it('cleans up stores and queries when Session deletion is confirmed', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({});

        deleteSession('session-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.delete', {
            sessionId: 'session-1',
        });
        expect(mocks.dropSessions).toHaveBeenCalledWith(['session-1']);
        expect(mocks.removeSessionQueries).toHaveBeenCalledWith(queryClient, ['session-1']);
        expect(mocks.refreshWorkbench).toHaveBeenCalled();
    });

    it('leaves stores and queries untouched when Session deletion is canceled', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({ canceled: true });

        deleteSession('session-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.dropSessions).not.toHaveBeenCalled();
        expect(mocks.removeSessionQueries).not.toHaveBeenCalled();
        expect(mocks.refreshWorkbench).not.toHaveBeenCalled();
    });

    it('resolves the selected Session and delegates the full deletion flow', async () => {
        mocks.getSelectedSession.mockReturnValue({ id: 'session-2' });
        mocks.caxriRequest.mockResolvedValueOnce({});

        deleteSelectedSession();
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.delete', {
            sessionId: 'session-2',
        });
        expect(mocks.dropSessions).toHaveBeenCalledWith(['session-2']);
    });

    it('does nothing when no Session is selected', () => {
        mocks.getSelectedSession.mockReturnValue(undefined);

        deleteSelectedSession();

        expect(mocks.caxriRequest).not.toHaveBeenCalled();
        expect(mocks.tryCommand).not.toHaveBeenCalled();
    });

    it('opens the Session a row double-click names, and leaves an open one alone', async () => {
        mocks.getBootstrap.mockReturnValue({ selectedSessionId: 'session-2' });
        mocks.caxriRequest.mockResolvedValueOnce({ id: 'session-1' });

        openSession('session-2');
        openSession('session-1');
        await vi.waitFor(() => expect(mocks.caxriRequest).toHaveBeenCalledOnce());

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.select', {
            sessionId: 'session-1',
        });
    });

    it('does not request a Terminal move when it is the only work tab', () => {
        moveTerminalToNewSession('terminal-1', true);

        expect(mocks.tryCommand).not.toHaveBeenCalled();
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
    });

    it('requests one Terminal move when another work tab keeps the Session open', async () => {
        moveTerminalToNewSession('terminal-1', false);
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledTimes(1);
        expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.moveToNewSession', {
            terminalId: 'terminal-1',
        });
        expect(mocks.tryCommand.mock.calls[0]?.[2]).toEqual({
            refresh: mocks.refreshWorkbench,
        });
    });
});
