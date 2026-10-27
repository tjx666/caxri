import type { ProjectRecord } from '@caxri/protocol';
import { isTopLevelProject } from '@caxri/protocol';

/**
 * The Projects a Project list renders as top-level entries, in their incoming order.
 *
 * Used by the PrimarySidebar tree and by the Command Palette's Projects group: the two surfaces where picking an
 * auto-registered worktree Project is meaningless, because it can never own a Session. Every consumer that needs the
 * authorization list (Session creation, the MRU switcher, the archived-Sessions dialog, bug reports, the Command
 * Palette's Sessions group, and the Workbench Root picker) keeps reading the full list.
 */
export function topLevelProjects(projects: readonly ProjectRecord[]): ProjectRecord[] {
    return projects.filter((project) => isTopLevelProject(project));
}

/**
 * The Project a Session currently works in when that differs from the Project that owns it, i.e. the Session is bound
 * to a Workbench Root other than its own. Returns `undefined` for the ordinary case and whenever the bound Project is
 * not in `projects`, so a stale binding renders no marker rather than an unlabeled one.
 */
export function sessionWorktreeProject(
    session: { projectId: string; workbenchRootProjectId: string },
    projects: readonly ProjectRecord[],
): ProjectRecord | undefined {
    if (session.workbenchRootProjectId === session.projectId) return undefined;
    return projects.find((project) => project.id === session.workbenchRootProjectId);
}
