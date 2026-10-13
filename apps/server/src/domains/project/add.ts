import type { ProjectRecord, ServerEvent } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import { resolveOwnerProjectRoot } from './root-identity';

/**
 * Adds an existing folder as a Project for a caller without a native folder picker: an Agent or the CLI through
 * `project.add`, and a paired device after its home-directory check. The canonical root is the identity, and
 * `database.createProject` is idempotent by root and un-hides a previously hidden Project, so re-adding a folder
 * returns the same Project instead of a duplicate row.
 */
export async function addProjectFolder(
    database: Pick<CaxriDatabase, 'createProject'>,
    emit: (event: ServerEvent) => void,
    absolutePath: string,
): Promise<ProjectRecord> {
    const project = database.createProject(await resolveOwnerProjectRoot(absolutePath));
    emit({ event: 'state.changed', payload: { kind: 'full', reason: 'project.create' } });
    return project;
}
