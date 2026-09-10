import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToastKind, ToastOptions } from '../../../stores/toasts';

const mocks = vi.hoisted(() => {
    const pushToast = vi.fn<(kind: ToastKind, message: string, options?: ToastOptions) => void>();
    return {
        askAgentForProject: vi.fn(),
        caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve([])),
        dropSessions: vi.fn(),
        getBootstrap: vi.fn(),
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
vi.mock('../../../stores/dialogs', () => ({
    clearPendingSession: vi.fn(),
    useDialogStore: {
        getState: vi.fn(() => ({ askAgentForProject: mocks.askAgentForProject })),
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
    archiveSelectedSession,
    archiveSession,
    deleteSelectedSession,
    deleteSession,
    describeArchivedSession,
    didReorderProject,
    didReorderSession,
    didSelectSession,
    moveTerminalToNewSession,
    openProjectInExternalEditor,
    openSelectedProjectInExternalEditor,
    openSelectedSessionPullRequest,
    selectAdjacentSession,
    selectProject,
} from '../session-actions';

describe('Session actions', () => {
    beforeEach(() => {
        mocks.askAgentForProject.mockClear();
        mocks.caxriRequest.mockClear();
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

    it('cancels the snapshot waiter when a reorder fails', async () => {
        const cancel = vi.fn();
        mocks.registerSessionCommandConvergence.mockReturnValueOnce({
            cancel,
            promise: new Promise(() => {}),
        });
        mocks.tryCommand.mockResolvedValueOnce(undefined);
        await expect(didReorderSession('session-1', 'missing', 'before')).resolves.toBe(false);
        expect(cancel).toHaveBeenCalledOnce();
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
        expect(mocks.removeSessionQueries).toHaveBeenCalledWith(expect.anything(), ['session-1']);
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

    it('records an archive as an undoable info notice naming the Session', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({ id: 'session-1', displayTitle: 'api-fix' });

        archiveSession('session-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.archive', {
            sessionId: 'session-1',
        });
        expect(mocks.tryCommand.mock.calls[0]?.[2]).toEqual({ refresh: mocks.refreshWorkbench });
        expect(mocks.pushToast).toHaveBeenCalledOnce();
        const [kind, message, options] = mocks.pushToast.mock.calls[0] ?? [];
        expect(kind).toBe('info');
        expect(message).toBe('Archived "api-fix"');
        expect(options?.action?.label).toBe('Undo');
        // Archiving is reversible, so the notice takes the ordinary four-second expiry.
        expect(options?.persist).toBeUndefined();
    });

    it('restores the archived Session when the notice Undo action is used', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({ id: 'session-1', displayTitle: 'api-fix' });
        archiveSession('session-1');
        await mocks.tryCommand.mock.results[0]?.value;
        mocks.caxriRequest.mockResolvedValueOnce({ id: 'session-1', displayTitle: 'api-fix' });

        mocks.pushToast.mock.calls[0]?.[2]?.action?.onSelect();
        await mocks.tryCommand.mock.results[1]?.value;

        expect(mocks.caxriRequest).toHaveBeenLastCalledWith('session.unarchive', {
            sessionId: 'session-1',
        });
        expect(mocks.tryCommand.mock.calls[1]?.[2]).toEqual({ refresh: mocks.refreshWorkbench });
    });

    it('reports a stale Undo as an error instead of throwing out of the notice', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({ id: 'session-1', displayTitle: 'api-fix' });
        archiveSession('session-1');
        await mocks.tryCommand.mock.results[0]?.value;
        // The Session was deleted, or the window navigated away, while the notice was still on screen.
        mocks.caxriRequest.mockRejectedValueOnce(new Error('Session not found'));

        expect(() => mocks.pushToast.mock.calls[0]?.[2]?.action?.onSelect()).not.toThrow();
        await mocks.tryCommand.mock.results[1]?.value;

        expect(mocks.pushToast).toHaveBeenLastCalledWith(
            'error',
            'Session restore failed: Session not found',
        );
    });

    it('stays silent when the archive request itself fails', async () => {
        mocks.caxriRequest.mockRejectedValueOnce(new Error('Server is not ready'));

        archiveSession('session-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.pushToast).toHaveBeenCalledExactlyOnceWith(
            'error',
            'Session archive failed: Server is not ready',
        );
    });

    it('archives the selected Session through the same notice path', async () => {
        mocks.getSelectedSession.mockReturnValue({ id: 'session-2' });
        mocks.caxriRequest.mockResolvedValueOnce({ id: 'session-2', displayTitle: 'docs' });

        archiveSelectedSession();
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.archive', {
            sessionId: 'session-2',
        });
        expect(mocks.pushToast).toHaveBeenCalledWith('info', 'Archived "docs"', expect.anything());
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

describe('Archived Session notice copy', () => {
    it('quotes the Session title', () => {
        expect(describeArchivedSession('api-fix')).toBe('Archived "api-fix"');
    });

    it('names the noun instead of quoting an empty or blank title', () => {
        expect(describeArchivedSession('')).toBe('Archived Session');
        expect(describeArchivedSession(' '.repeat(3))).toBe('Archived Session');
        expect(describeArchivedSession(undefined)).toBe('Archived Session');
    });

    it('trims surrounding whitespace before quoting', () => {
        expect(describeArchivedSession('  api-fix\n')).toBe('Archived "api-fix"');
    });

    it('truncates a runaway title so the Undo action keeps its room', () => {
        const message = describeArchivedSession('a'.repeat(400));

        expect(message).toBe(`Archived "${'a'.repeat(48)}…"`);
        expect(message.length).toBeLessThan(64);
    });

    it('does not leave a dangling space before the ellipsis', () => {
        expect(describeArchivedSession(`${'a'.repeat(47)} tail`)).toBe(
            `Archived "${'a'.repeat(47)}…"`,
        );
    });

    it('never cuts a surrogate pair in half', () => {
        const message = describeArchivedSession('🚀'.repeat(60));

        expect(message).toBe(`Archived "${'🚀'.repeat(48)}…"`);
        expect(message).not.toContain('�');
        expect(message.split('\u{D83D}').length - 1).toBe(48);
    });
});
