import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    askAgentForProject: vi.fn(),
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve([])),
    dropSessions: vi.fn(),
    getBootstrap: vi.fn(),
    getSelectedSession: vi.fn(),
    registerSessionSelectionConvergence: vi.fn(() => ({
        cancel: vi.fn(),
        promise: Promise.resolve(),
    })),
    refreshWorkbench: vi.fn(() => Promise.resolve()),
    removeSessionQueries: vi.fn(),
    tryCommand: vi.fn(
        async (
            ...[, run]: [string, () => Promise<unknown>, { refresh?: () => Promise<void> }?]
        ): Promise<unknown> => run(),
    ),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));
vi.mock('../../../queries/client', () => ({ queryClient: {} }));
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
    selectSelectedProject: vi.fn(),
    selectSelectedSession: vi.fn(),
}));
vi.mock('../../../stores/session-view', () => ({
    useSessionViewStore: { getState: vi.fn(() => ({ dropSessions: mocks.dropSessions })) },
}));
vi.mock('../../../stores/toasts', () => ({ tryCommand: mocks.tryCommand }));
vi.mock('../../../stores/workbench', () => ({
    registerSessionSelectionConvergence: mocks.registerSessionSelectionConvergence,
    refreshWorkbench: mocks.refreshWorkbench,
    useWorkbenchStore: { getState: () => ({ bootstrap: undefined }) },
}));

import {
    deleteSelectedSession,
    deleteSession,
    didReorderProject,
    didSelectSession,
    moveTerminalToNewSession,
    selectAdjacentSession,
    selectProject,
} from '../session-actions';

describe('Session actions', () => {
    beforeEach(() => {
        mocks.askAgentForProject.mockClear();
        mocks.caxriRequest.mockClear();
        mocks.dropSessions.mockClear();
        mocks.getBootstrap.mockReset();
        mocks.getSelectedSession.mockReset();
        mocks.registerSessionSelectionConvergence.mockClear();
        mocks.refreshWorkbench.mockClear();
        mocks.removeSessionQueries.mockClear();
        mocks.tryCommand.mockClear();
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
        mocks.registerSessionSelectionConvergence.mockReturnValueOnce({
            cancel,
            promise: convergence.promise,
        });

        const selected = didSelectSession('session-2');
        await vi.waitFor(() => expect(mocks.caxriRequest).toHaveBeenCalledOnce());

        expect(mocks.registerSessionSelectionConvergence.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.caxriRequest.mock.invocationCallOrder[0],
        );
        await expect(Promise.race([selected, Promise.resolve('pending')])).resolves.toBe('pending');

        convergence.resolve();
        await expect(selected).resolves.toBe(true);
        expect(cancel).not.toHaveBeenCalled();
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
        expect(mocks.removeSessionQueries).toHaveBeenCalledWith({}, ['session-1']);
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
