import { lstat, realpath } from 'node:fs/promises';

import type { StructuredLogger } from '@caxri/system';

import type { DelegationWorktree } from '../agent-delegation';
import type { CaxriDatabase } from '../db';
import { createServerLinkedWorktree } from '../git';

/**
 * Creates a linked worktree of a top-level Project on a new branch and registers it as that Project's worktree Project,
 * before the Session that will work in it exists. Git runs first so a refusal leaves no Session to remove. The worktree
 * stays on disk when the delegation is later refused: Caxri owns no cleanup policy for it.
 */
export async function prepareDelegatedWorktree(
    options: { database: CaxriDatabase; logger: StructuredLogger },
    ownerProjectId: string,
    ownerRoot: string,
    branch: string,
): Promise<DelegationWorktree> {
    const created = await createServerLinkedWorktree(options.logger, { ownerRoot, branch });
    const rootPath = await realpath(created);
    const stats = await lstat(rootPath, { bigint: true });
    const project = options.database.createProject(rootPath, ownerProjectId);
    return {
        projectId: project.id,
        identity: { device: stats.dev.toString(), inode: stats.ino.toString() },
    };
}
