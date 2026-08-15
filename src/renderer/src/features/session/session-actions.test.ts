import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    askAgentForProject: vi.fn(),
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve([])),
    dropSessions: vi.fn(),
    getBootstrap: vi.fn(),
    getSelectedSession: vi.fn(),
    refreshWorkbench: vi.fn(() => Promise.resolve()),
    removeSessionQueries: vi.fn(),
    tryCommand: vi.fn(
        async (
            ...[, run]: [string, () => Promise<unknown>, { refresh?: boolean }?]
        ): Promise<unknown> => run(),
    ),
}));

vi.mock('../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));
vi.mock('../../queries/client', () => ({ queryClient: {} }));
vi.mock('../../queries/invalidation', () => ({ removeSessionQueries: mocks.removeSessionQueries }));
vi.mock('../../stores/dialogs', () => ({
    clearPendingSession: vi.fn(),
    useDialogStore: {
        getState: vi.fn(() => ({ askAgentForProject: mocks.askAgentForProject })),
    },
}));
vi.mock('../../stores/selectors', () => ({
    getBootstrap: mocks.getBootstrap,
    getSelectedSession: mocks.getSelectedSession,
    selectSelectedProject: vi.fn(),
}));
vi.mock('../../stores/session-view', () => ({
    useSessionViewStore: { getState: vi.fn(() => ({ dropSessions: mocks.dropSessions })) },
}));
vi.mock('../../stores/toasts', () => ({ tryCommand: mocks.tryCommand }));
vi.mock('../../stores/workbench', () => ({ refreshWorkbench: mocks.refreshWorkbench }));

import {
    deleteSelectedSession,
    deleteSession,
    didReorderProject,
    selectProject,
} from './session-actions';

describe('Session actions', () => {
    beforeEach(() => {
        mocks.askAgentForProject.mockClear();
        mocks.caxriRequest.mockClear();
        mocks.dropSessions.mockClear();
        mocks.getBootstrap.mockReset();
        mocks.getSelectedSession.mockReset();
        mocks.refreshWorkbench.mockClear();
        mocks.removeSessionQueries.mockClear();
        mocks.tryCommand.mockClear();
    });

    it('does not start Session creation when a Project has no active Sessions', () => {
        mocks.getBootstrap.mockReturnValue({
            sessions: [
                {
                    archivedAt: Date.now(),
                    id: 'session-1',
                    projectId: 'project-1',
                },
            ],
            settings: {},
        });

        selectProject('project-1');

        expect(mocks.askAgentForProject).not.toHaveBeenCalled();
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
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
});
