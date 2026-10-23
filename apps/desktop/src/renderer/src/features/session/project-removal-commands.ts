import type { BootstrapState } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { queryClient } from '../../queries/client';
import { removeSessionQueries } from '../../queries/invalidation';
import { getBootstrap, selectSelectedProject } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';

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
        await dropProjectFromWorkbench(bootstrap, project.id);
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
        await dropProjectFromWorkbench(bootstrap, project.id);
    });
}

/**
 * Deletion and hiding both take the worktree Projects auto-registered on this Project's behalf with it, so their
 * Sessions leave the Workbench too. `refreshWorkbench` only replaces bootstrap state; per-Session view state and cached
 * queries need this explicit cleanup or they would outlive the rows they describe.
 */
async function dropProjectFromWorkbench(
    bootstrap: BootstrapState,
    projectId: string,
): Promise<void> {
    const removedProjectIds = new Set([
        projectId,
        ...bootstrap.projects.flatMap((candidate) =>
            candidate.ownerProjectId === projectId ? [candidate.id] : [],
        ),
    ]);
    const removedSessionIds: string[] = [];
    for (const session of bootstrap.sessions)
        if (removedProjectIds.has(session.projectId)) removedSessionIds.push(session.id);
    useSessionViewStore.getState().dropSessions(removedSessionIds);
    removeSessionQueries(queryClient, removedSessionIds);
    await refreshWorkbench();
}
