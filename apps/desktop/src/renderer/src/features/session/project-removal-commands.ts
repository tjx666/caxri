import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { getBootstrap, selectSelectedProject } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';

/**
 * Deletes every checkout under a merged side bar heading, one confirmation at a time, and stops at the first one the
 * user cancels or that fails.
 */
export function deleteMergedProjects(projectIds: readonly string[]): void {
    const bootstrap = getBootstrap();
    if (!bootstrap) return;
    // Fire-and-forget: `tryCommand` funnels each request's own failure into a toast internally.
    void (async () => {
        for (const projectId of projectIds) {
            // eslint-disable-next-line no-await-in-loop -- one native confirmation at a time, and a cancel stops the rest
            const deleted = await tryCommand(
                translate('session.errors.deleteProjectFailed'),
                async () => {
                    const result = await caxri.request('project.delete', { projectId });
                    if ('canceled' in result) return false;
                    // The worktree Projects registered on this Project's behalf leave with it; their Sessions' per-Session Renderer
                    // state is released by `useDepartedSessionCleanup` once the refreshed list drops them.
                    await refreshWorkbench();
                    return true;
                },
            );
            if (!deleted) return;
        }
    })();
}

export function deleteProject(projectId?: string): void {
    const bootstrap = getBootstrap();
    const project =
        projectId === undefined
            ? selectSelectedProject(bootstrap)
            : bootstrap?.projects.find((candidate) => candidate.id === projectId);
    if (!bootstrap || !project) return;
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    void tryCommand(translate('session.errors.deleteProjectFailed'), async () => {
        const result = await caxri.request('project.delete', { projectId: project.id });
        if ('canceled' in result) return;
        // The worktree Projects registered on this Project's behalf leave with it; their Sessions' per-Session Renderer
        // state is released by `useDepartedSessionCleanup` once the refreshed list drops them.
        await refreshWorkbench();
    });
}

/**
 * Hiding needs no confirmation: every record survives, and adding the same folder again brings the Project back.
 *
 * `projectId` lets the Project row's context menu hide the clicked Project directly, since a right-click does not
 * change which Project is selected; the menu bar and command palette omit it and keep hiding the selected Project.
 */
export function hideSelectedProject(projectId?: string): void {
    const bootstrap = getBootstrap();
    const project =
        projectId === undefined
            ? selectSelectedProject(bootstrap)
            : bootstrap?.projects.find((candidate) => candidate.id === projectId);
    if (!bootstrap || !project) return;
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    void tryCommand(translate('session.errors.hideProjectFailed'), async () => {
        await caxri.request('project.hide', { projectId: project.id });
        // The worktree Projects registered on this Project's behalf leave with it; their Sessions' per-Session Renderer
        // state is released by `useDepartedSessionCleanup` once the refreshed list drops them.
        await refreshWorkbench();
    });
}
