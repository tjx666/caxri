import { lstat } from 'node:fs/promises';

import type { ProjectRecord, ServerEvent } from '@caxri/protocol';
import { isTopLevelProject } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import type { WorktreeTopologyReader } from '../session';
import { worktreePlacement } from '../session';
import { resolveOwnerProjectRoot } from './root-identity';

/**
 * What adding a folder did to the Project list: a new row, the unchanged visible one, a hidden one brought back, or a
 * registered worktree Project promoted to top level. A closed value, safe to log.
 */
type ProjectAddOutcome = 'created' | 'existing' | 'unhidden' | 'adopted_worktree';

/**
 * Adds an existing folder as a Project for a caller without a native folder picker: an Agent or the CLI through
 * `project.add`, and a paired device after its home-directory check. The canonical root is the identity, and
 * `database.createProject` is idempotent by root and un-hides a previously hidden Project, so re-adding a folder
 * returns the same Project instead of a duplicate row. `outcome` says which of those happened.
 */
async function addProjectFolderWithOutcome(
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
 * Where a delegation that names a folder runs: the Project its Session belongs to and, when the folder is a registered
 * linked worktree, that worktree as the Session's Workbench root.
 */
export interface DelegationFolder {
    projectId: string;
    /**
     * `worktree`: the folder was already a registered worktree of a visible Project. `registered_worktree`: it was an
     * unregistered linked worktree of a visible Project's repository and was registered under that owner just now.
     */
    outcome: ProjectAddOutcome | 'worktree' | 'registered_worktree';
    worktree?: { projectId: string; identity: { device: string; inode: string } };
}

async function worktreeOf(
    root: string,
    projectId: string,
): Promise<NonNullable<DelegationFolder['worktree']>> {
    const stats = await lstat(root, { bigint: true });
    return {
        projectId,
        identity: { device: stats.dev.toString(), inode: stats.ino.toString() },
    };
}

/**
 * Resolves a delegation's `projectPath`. Naming a folder there says where the task runs, not that the user chose to
 * show it in the sidebar, so a linked worktree of a visible Project stays under that owner: the Session belongs to the
 * owner and works in the worktree, as a Session whose Agent moved into that worktree does. That holds for a worktree
 * already registered (`worktree`) and for one an Agent created with plain `git worktree add` and never registered
 * (`registered_worktree`). Adding the latter as a top-level Project would put it beside its owner, and leave an empty
 * row there once the checkout is removed. A registered worktree whose owner is hidden is promoted (`adopted_worktree`).
 * Any other folder is added the way `project add` adds it.
 */
export async function resolveDelegationFolder(
    database: Pick<
        CaxriDatabase,
        'createProject' | 'findProjectByRootPath' | 'getProject' | 'listVisibleProjects'
    >,
    emit: (event: ServerEvent) => void,
    absolutePath: string,
    readTopology: WorktreeTopologyReader,
): Promise<DelegationFolder> {
    const root = await resolveOwnerProjectRoot(absolutePath);
    const registered = database.findProjectByRootPath(root);
    const owner = registered?.ownerProjectId
        ? database.getProject(registered.ownerProjectId)
        : undefined;
    if (registered && owner && registered.hiddenAt === undefined && owner.hiddenAt === undefined)
        return {
            projectId: owner.id,
            outcome: 'worktree',
            worktree: await worktreeOf(root, registered.id),
        };
    if (!registered) {
        const placement = await worktreePlacement(
            database.listVisibleProjects(),
            root,
            readTopology,
        );
        // Only the worktree root itself: a subfolder of a checkout is not a Workbench Root and is added as before.
        if (placement?.worktreeRoot === root) {
            const worktree = database.createProject(root, placement.project.id);
            emit({ event: 'state.changed', payload: { kind: 'full', reason: 'project.create' } });
            return {
                projectId: placement.project.id,
                outcome: 'registered_worktree',
                worktree: await worktreeOf(root, worktree.id),
            };
        }
    }
    const { project, outcome } = await addProjectFolderWithOutcome(database, emit, root);
    return { projectId: project.id, outcome };
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
