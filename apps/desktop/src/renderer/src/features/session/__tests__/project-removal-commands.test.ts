import type { BootstrapState } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve({})),
    dropSessions: vi.fn(),
    getBootstrap: vi.fn<() => BootstrapState | undefined>(),
    refreshWorkbench: vi.fn(() => Promise.resolve()),
    removeSessionQueries: vi.fn(),
    selectSelectedProject: vi.fn(),
    // Mirrors the real funnel closely enough for these tests: it awaits the action so a test can wait on the same
    // promise `hideSelectedProject`/`deleteProject` fire-and-forget internally.
    tryCommand: vi.fn((_title: string, action: () => Promise<unknown>) => action()),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));
vi.mock('../../../queries/invalidation', () => ({
    removeSessionQueries: mocks.removeSessionQueries,
}));
vi.mock('../../../stores/selectors', () => ({
    getBootstrap: mocks.getBootstrap,
    selectSelectedProject: mocks.selectSelectedProject,
}));
vi.mock('../../../stores/session-view', () => ({
    useSessionViewStore: { getState: vi.fn(() => ({ dropSessions: mocks.dropSessions })) },
}));
vi.mock('../../../stores/toasts', () => ({ tryCommand: mocks.tryCommand }));
vi.mock('../../../stores/workbench', () => ({ refreshWorkbench: mocks.refreshWorkbench }));

import { deleteProject, hideSelectedProject } from '../project-removal-commands';

function bootstrapWith(projectIds: string[]): BootstrapState {
    return {
        projects: projectIds.map((id) => ({ id, title: id, rootPath: `/${id}` })),
        sessions: [],
    } as unknown as BootstrapState;
}

describe('Project removal commands', () => {
    beforeEach(() => {
        mocks.caxriRequest.mockClear();
        mocks.dropSessions.mockClear();
        mocks.getBootstrap.mockReset();
        mocks.refreshWorkbench.mockClear();
        mocks.removeSessionQueries.mockClear();
        mocks.selectSelectedProject.mockReset();
        mocks.tryCommand.mockClear();
    });

    describe('hideSelectedProject', () => {
        it('hides the selected Project when called with no id, for the menu bar and command palette', async () => {
            const bootstrap = bootstrapWith(['selected-project', 'other-project']);
            mocks.getBootstrap.mockReturnValue(bootstrap);
            mocks.selectSelectedProject.mockReturnValue(bootstrap.projects[0]);

            hideSelectedProject();
            await mocks.tryCommand.mock.results[0]?.value;

            expect(mocks.caxriRequest).toHaveBeenCalledWith('project.hide', {
                projectId: 'selected-project',
            });
        });

        /**
         * A right-click on a Project row does not change the selected Project, so the row menu passes the clicked
         * Project's id explicitly; this must hide that Project even when a different one is selected.
         */
        it('hides the clicked Project by id, ignoring the selected Project', async () => {
            const bootstrap = bootstrapWith(['selected-project', 'clicked-project']);
            mocks.getBootstrap.mockReturnValue(bootstrap);
            mocks.selectSelectedProject.mockReturnValue(bootstrap.projects[0]);

            hideSelectedProject('clicked-project');
            await mocks.tryCommand.mock.results[0]?.value;

            expect(mocks.caxriRequest).toHaveBeenCalledWith('project.hide', {
                projectId: 'clicked-project',
            });
            expect(mocks.selectSelectedProject).not.toHaveBeenCalled();
        });

        it('does nothing when the clicked id does not match a known Project', () => {
            const bootstrap = bootstrapWith(['selected-project']);
            mocks.getBootstrap.mockReturnValue(bootstrap);
            mocks.selectSelectedProject.mockReturnValue(bootstrap.projects[0]);

            hideSelectedProject('missing-project');

            expect(mocks.tryCommand).not.toHaveBeenCalled();
            expect(mocks.caxriRequest).not.toHaveBeenCalled();
        });

        it('drops the hidden Project (and its Sessions) from the Workbench', async () => {
            const bootstrap = bootstrapWith(['clicked-project']);
            mocks.getBootstrap.mockReturnValue(bootstrap);

            hideSelectedProject('clicked-project');
            await mocks.tryCommand.mock.results[0]?.value;

            expect(mocks.dropSessions).toHaveBeenCalledWith([]);
            expect(mocks.removeSessionQueries).toHaveBeenCalled();
            expect(mocks.refreshWorkbench).toHaveBeenCalled();
        });
    });

    describe('deleteProject', () => {
        it('deletes the explicitly given Project id, matching the row menu clicked-id path', async () => {
            const bootstrap = bootstrapWith(['selected-project', 'clicked-project']);
            mocks.getBootstrap.mockReturnValue(bootstrap);
            mocks.selectSelectedProject.mockReturnValue(bootstrap.projects[0]);
            mocks.caxriRequest.mockResolvedValue({ deleted: true });

            deleteProject('clicked-project');
            await mocks.tryCommand.mock.results[0]?.value;

            expect(mocks.caxriRequest).toHaveBeenCalledWith('project.delete', {
                projectId: 'clicked-project',
            });
        });
    });
});
