import type { ProjectQueryResult } from '@caxri/protocol';
import { isTopLevelProject } from '@caxri/protocol';

/**
 * Separates the Projects a pairing can grant (the PrimarySidebar's top-level Projects) from auto-registered worktree
 * Projects. A paired device never lists a worktree Project, so offering one in the pairing checklist only spent a grant
 * slot on an entry the phone hides; the ids are kept so an older device's Access line can skip them. Only the Desktop
 * view carries `ownerProjectId`; a scoped view has nothing to split.
 */
export function splitGrantableProjects(result: ProjectQueryResult): {
    projects: ProjectQueryResult['projects'];
    worktreeProjectIds: ReadonlySet<string>;
} {
    if (result.view !== 'desktop' && result.view !== 'human-cli')
        return { projects: result.projects, worktreeProjectIds: new Set() };
    return {
        projects: result.projects.filter((project) => isTopLevelProject(project)),
        worktreeProjectIds: new Set(
            result.projects
                .filter((project) => !isTopLevelProject(project))
                .map((project) => project.id),
        ),
    };
}

/**
 * A paired device's `Access:` line used to repeat the literal `Unavailable Project` once per grant the current window
 * cannot resolve: a device with several stale grants read as `Unavailable Project, Unavailable Project, …`, which is
 * also what stretched the Paired devices card past the Settings content column (no single word to truncate against).
 * Collapsing every unresolved grant into one trailing `+N unavailable` keeps the line honest (the device still has that
 * many grants) without repeating a word that carries no new information after the first time.
 */
export function summarizeProjectAccess(titles: ReadonlyArray<string | undefined>): string {
    const known = titles.filter((title): title is string => title !== undefined);
    const unavailableCount = titles.length - known.length;
    if (unavailableCount === 0) return known.join(', ');
    const suffix = `+${unavailableCount} unavailable`;
    return known.length > 0 ? `${known.join(', ')} · ${suffix}` : suffix;
}
