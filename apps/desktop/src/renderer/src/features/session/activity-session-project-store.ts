import type { ProjectRecord } from '@caxri/protocol';

import { createSharedLocalState } from '../../lib/local-storage';
import { createStore } from '../../lib/store';

const ACTIVITY_SESSION_PROJECT_STORAGE_KEY = 'caxri.session.activityNewSessionProject';

/**
 * The Project the user last picked in the Activity view's New Session list, remembered on this device. Without it the
 * row's target reverted to the selected Session's Project as soon as the menu closed, so a user who switched Projects
 * and clicked away had to switch again on every press. Presentation state only: it never reaches `settings.jsonc`.
 */
export interface ActivitySessionProject {
    projectId: string | undefined;
}

export function parseActivitySessionProject(stored: unknown): ActivitySessionProject {
    return { projectId: typeof stored === 'string' && stored.length > 0 ? stored : undefined };
}

/**
 * Shared by every window of the profile (docs/client-local-data.md): the last pick is the user's, so a pick in one
 * window becomes the target in the others.
 */
const sharedProject = createSharedLocalState(
    ACTIVITY_SESSION_PROJECT_STORAGE_KEY,
    parseActivitySessionProject,
);

export const useActivitySessionProjectStore = createStore<ActivitySessionProject>(
    'activity-session-project',
    (set) => {
        // Memory only, so another window's pick never writes back.
        sharedProject.subscribe((state) => set(state));
        return sharedProject.read();
    },
);

/**
 * Records an explicit Project pick from the Activity New Session list.
 */
export function rememberActivitySessionProject(projectId: string): void {
    if (useActivitySessionProjectStore.getState().projectId === projectId) return;
    useActivitySessionProjectStore.setState({ projectId });
    sharedProject.write(projectId);
}

/**
 * The Project the Activity New Session row targets: the remembered pick while it is still listed, else the selected
 * Session's Project, else the first listed one. A removed or hidden Project therefore falls back instead of naming a
 * Project the menu cannot offer.
 */
export function resolveActivitySessionProject(
    projects: readonly ProjectRecord[],
    rememberedProjectId: string | undefined,
    selectedProjectId: string | undefined,
): ProjectRecord | undefined {
    return (
        projects.find((project) => project.id === rememberedProjectId) ??
        projects.find((project) => project.id === selectedProjectId) ??
        projects.at(0)
    );
}
