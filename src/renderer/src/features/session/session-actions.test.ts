import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    askAgentForProject: vi.fn(),
    caxriRequest: vi.fn(() => Promise.resolve([])),
    getBootstrap: vi.fn(),
    tryCommand: vi.fn(
        async (
            ...[, run]: [string, () => Promise<unknown>, { refresh?: boolean }?]
        ): Promise<unknown> => run(),
    ),
}));

vi.mock('../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));
vi.mock('../../queries/client', () => ({ queryClient: {} }));
vi.mock('../../queries/invalidation', () => ({ removeSessionQueries: vi.fn() }));
vi.mock('../../stores/dialogs', () => ({
    clearPendingSession: vi.fn(),
    useDialogStore: {
        getState: vi.fn(() => ({ askAgentForProject: mocks.askAgentForProject })),
    },
}));
vi.mock('../../stores/selectors', () => ({
    getBootstrap: mocks.getBootstrap,
    getSelectedSession: vi.fn(),
    selectSelectedProject: vi.fn(),
}));
vi.mock('../../stores/session-view', () => ({
    useSessionViewStore: { getState: vi.fn(() => ({})) },
}));
vi.mock('../../stores/toasts', () => ({ tryCommand: mocks.tryCommand }));
vi.mock('../../stores/workbench', () => ({ refreshWorkbench: vi.fn() }));

import { reorderProject, selectProject } from './session-actions';

describe('Session actions', () => {
    beforeEach(() => {
        mocks.askAgentForProject.mockClear();
        mocks.caxriRequest.mockClear();
        mocks.getBootstrap.mockReset();
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
        await expect(reorderProject('project-1', 2)).resolves.toBe(true);

        expect(mocks.caxriRequest).toHaveBeenCalledWith('project.reorder', {
            projectId: 'project-1',
            targetIndex: 2,
        });
        expect(mocks.tryCommand.mock.calls[0]?.[2]).toBeUndefined();
    });
});
