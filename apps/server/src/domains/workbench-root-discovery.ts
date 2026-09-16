import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { ProjectRecord, WorkbenchRootOption } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { GitWorktreeTopology } from './git';

/**
 * Keeps an existing Project reachable when Git cannot describe it; the fallback ID cannot authorize a new root.
 */
export function unavailableWorkbenchRoot(
    project: ProjectRecord,
    ownerId: string,
): WorkbenchRootOption {
    return {
        projectId: project.id,
        worktreeId: project.id,
        authorization: 'authorized',
        rootPath: project.rootPath,
        isMain: false,
        displayTitle: project.displayTitle,
        branch: 'No branch',
        owner: project.id === ownerId,
    };
}

/**
 * Decides whether a persisted Workbench Root binding still names the directory it was authorized against.
 *
 * Only the inode is load-bearing. `st_dev` is not a durable identifier: on macOS it is the device number of the
 * volume's `/dev/diskNsM` node, and the kernel re-allocates those nodes on every boot, in an enumeration order that
 * does not follow partition order. Comparing a stored device number against the live one therefore made every Workbench
 * Root binding fail the first validation sweep after a restart, with nothing on disk changed.
 *
 * The inode keeps the check honest: a worktree removed and re-added, or a directory deleted and recreated at the same
 * path, gets a new inode. Callers reach this only after Git topology has confirmed the path is still a linked worktree
 * of the owning repository and after `realpath` proved the path is not a symlink, so the device number adds no
 * detection the inode does not already provide.
 *
 * @see https://github.com/tjx666/caxri/issues/1003
 */
export function isSameWorkbenchRootIdentity(
    binding: { rootInode?: string },
    identity: { inode: string },
): boolean {
    return binding.rootInode !== undefined && binding.rootInode === identity.inode;
}

/**
 * Includes inode identity so a menu displayed before directory replacement cannot authorize its replacement.
 */
export function worktreeIdentityId(
    repoKey: string,
    rootPath: string,
    identity: { device: string; inode: string },
    sessionId: string,
): string {
    return createHash('sha256')
        .update(JSON.stringify([repoKey, sessionId, rootPath, identity.device, identity.inode]))
        .digest('hex');
}

/**
 * The linked worktree's .git pointer is created by Git even when the checkout directory existed beforehand. Unknown
 * birth times remain unknown: mtime would reorder entries after repair/move operations.
 */
async function worktreeCreatedAt(rootPath: string): Promise<number | undefined> {
    try {
        const stats = await lstat(join(rootPath, '.git'));
        return stats.isFile() && Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0
            ? stats.birthtimeMs
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Projects are looked up only to annotate authority. Discovery never registers a Project or emits an Agent prompt.
 */
export async function discoverWorkbenchRoots(
    topology: GitWorktreeTopology,
    projects: readonly ProjectRecord[],
    ownerId: string,
    sessionId: string,
): Promise<WorkbenchRootOption[]> {
    if (topology.worktrees.length > 1_024)
        throw new CaxriError('UNAVAILABLE', 'Too many worktrees to display');
    const projectsByRoot = new Map(projects.map((project) => [project.rootPath, project]));
    const options = await Promise.all(
        topology.worktrees.map(async (worktree, index) => {
            try {
                const stats = await lstat(worktree.rootPath, { bigint: true });
                if (!stats.isDirectory() || stats.isSymbolicLink()) return [];
                const project = projectsByRoot.get(worktree.rootPath);
                const isMain = worktree.isMain ?? index === 0;
                const createdAt = isMain ? undefined : await worktreeCreatedAt(worktree.rootPath);
                return [
                    {
                        worktreeId: worktreeIdentityId(
                            topology.repositoryKey,
                            worktree.rootPath,
                            {
                                device: stats.dev.toString(),
                                inode: stats.ino.toString(),
                            },
                            sessionId,
                        ),
                        ...(project && { projectId: project.id }),
                        authorization: project ? ('authorized' as const) : ('required' as const),
                        rootPath: worktree.rootPath,
                        displayTitle: project?.displayTitle ?? basename(worktree.rootPath),
                        branch: worktree.branch,
                        owner: project?.id === ownerId,
                        isMain,
                        ...(createdAt && { createdAt }),
                    },
                ];
            } catch {
                // A stale topology entry must disappear instead of becoming an authorizable path.
                return [];
            }
        }),
    );
    return options.flat();
}
