import type { ProjectRecord, ServerEvent } from '@caxri/protocol';
import { isTopLevelProject } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import { resolveOwnerProjectRoot } from './root-identity';

/**
 * What adding a folder did to the Project list: a new row, the unchanged visible one, a hidden one brought back, or a
 * registered worktree Project promoted to top level. A closed value, safe to log.
 */
export type ProjectAddOutcome = 'created' | 'existing' | 'unhidden' | 'adopted_worktree';

/**
 * Adds an existing folder as a Project for a caller without a native folder picker: an Agent or the CLI through
 * `project.add`, and a paired device after its home-directory check. The canonical root is the identity, and
 * `database.createProject` is idempotent by root and un-hides a previously hidden Project, so re-adding a folder
 * returns the same Project instead of a duplicate row. `outcome` says which of those happened.
 */
export async function addProjectFolderWithOutcome(
    database: Pick<CaxriDatabase, 'createProject' | 'findProjectByRootPath'>,
    emit: (event: ServerEvent) => void,
    absolutePath: string,
): Promise<{ project: ProjectRecord; outcome: ProjectAddOutcome }> {
    const root = await resolveOwnerProjectRoot(absolutePath);
    const before = database.findProjectByRootPath(root);
    const project = database.createProject(root);
    emit({ event: 'state.changed', payload: { kind: 'full', reason: 'project.create' } });
    if (!before) return { project, outcome: 'created' };
    if (!isTopLevelProject(before)) return { project, outcome: 'adopted_worktree' };
    return { project, outcome: before.hiddenAt === undefined ? 'existing' : 'unhidden' };
}

/**
 * `addProjectFolderWithOutcome` for a caller that only needs the Project.
 */
export async function addProjectFolder(
    database: Pick<CaxriDatabase, 'createProject' | 'findProjectByRootPath'>,
    emit: (event: ServerEvent) => void,
    absolutePath: string,
): Promise<ProjectRecord> {
    return (await addProjectFolderWithOutcome(database, emit, absolutePath)).project;
}
