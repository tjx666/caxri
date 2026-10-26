import type { ProjectRecord } from '@caxri/protocol';
import { isTopLevelProject } from '@caxri/protocol';

/**
 * What the Welcome view offers as its primary action. A user with no Project can only add one; a user who already has
 * Projects but no selected Session is better served by a new Session in the Project they used last than by being sent
 * back to the folder picker.
 */
export type WelcomeAction =
    { kind: 'addProject' } | { kind: 'newSession'; projectId: string; projectTitle: string };

/**
 * Picks the Welcome primary action from the Projects the user can see. Worktree Projects registered on an owner's
 * behalf are skipped: they are not listed in the Primary Side Bar, so offering one would start a Session the user
 * cannot find. Ties on `lastOpenedAt` keep the earlier listed Project, matching the sidebar order.
 */
export function selectWelcomeAction(projects: readonly ProjectRecord[]): WelcomeAction {
    let latest: ProjectRecord | undefined;
    for (const project of projects) {
        if (!isTopLevelProject(project)) continue;
        if (!latest || project.lastOpenedAt > latest.lastOpenedAt) latest = project;
    }
    return latest
        ? { kind: 'newSession', projectId: latest.id, projectTitle: latest.displayTitle }
        : { kind: 'addProject' };
}
