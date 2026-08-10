import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn(() => Promise.resolve([])),
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
    useDialogStore: { getState: vi.fn(() => ({})) },
}));
vi.mock('../../stores/selectors', () => ({
    getBootstrap: vi.fn(),
    getSelectedSession: vi.fn(),
    selectSelectedProject: vi.fn(),
}));
vi.mock('../../stores/session-view', () => ({
    useSessionViewStore: { getState: vi.fn(() => ({})) },
}));
vi.mock('../../stores/toasts', () => ({ tryCommand: mocks.tryCommand }));
vi.mock('../../stores/workbench', () => ({ refreshWorkbench: vi.fn() }));

import { reorderProject } from './session-actions';

describe('Session actions', () => {
    beforeEach(() => {
        mocks.caxriRequest.mockClear();
        mocks.tryCommand.mockClear();
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
