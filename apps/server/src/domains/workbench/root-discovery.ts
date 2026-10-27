import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { ProjectRecord, SessionRecord, WorkbenchRootOption } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { GitWorktreeTopology } from '../git';

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
        title: project.title,
        branch: 'No branch',
        owner: project.id === ownerId,
    };
}

/**
 * The whole menu when Git topology is unreadable: the owning Project, plus the Session's current binding when it is a
 * different Project. Neither entry is newly authorized: both already exist in the database.
 */
export function unavailableWorkbenchRoots(
    owner: ProjectRecord,
    active: ProjectRecord | undefined,
): WorkbenchRootOption[] {
    const projects = [owner, ...(active && active.id !== owner.id ? [active] : [])];
    return projects.map((project) => unavailableWorkbenchRoot(project, owner.id));
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
 * How many worktrees the picker may lead with. Beyond a handful the group stops being a shortcut and becomes a second
 * list to read.
 */
const MAX_CONVERSATION_RECOMMENDATIONS = 3;

/**
 * Ranks the discovered worktrees this Session's conversation actually named, most recently named first.
 *
 * The conversation is treated purely as a _filter over what Git already reported_: a directory or branch it mentioned
 * matters only when it resolves to a worktree that discovery independently found and stat'd. A path the Agent printed
 * therefore cannot introduce a root, cannot change a root's authorization, and cannot survive the worktree being
 * removed; at worst it reorders a menu.
 *
 * Directories outrank branches because a directory is where work happened, while a branch name may be quoted in
 * passing. Within each, recency wins.
 */
function rankConversationWorktrees(
    options: readonly WorkbenchRootOption[],
    context: { branches: readonly string[]; directories: readonly string[] },
    limit = MAX_CONVERSATION_RECOMMENDATIONS,
): Map<string, number> {
    const byRootPath = new Map(options.map((option) => [option.rootPath, option]));
    const byBranch = new Map<string, WorkbenchRootOption>();
    for (const option of options)
        if (!byBranch.has(option.branch)) byBranch.set(option.branch, option);
    const ranked = new Map<string, number>();
    const remember = (option: WorkbenchRootOption | undefined): void => {
        // The Session is bound to the main worktree by definition here, so recommending it says nothing.
        if (!option || option.isMain || ranked.has(option.worktreeId) || ranked.size >= limit)
            return;
        ranked.set(option.worktreeId, ranked.size);
    };
    for (const directory of context.directories) remember(byRootPath.get(directory));
    for (const branch of context.branches) remember(byBranch.get(branch));
    return ranked;
}

/**
 * Annotates the discovered options with `conversationRank`, but only while the Session is still bound to the
 * repository's main worktree.
 *
 * Once the user has moved to a task worktree, the binding _is_ the answer to "which worktree is this about", and
 * re-suggesting whatever the Agent last mentioned would argue with a choice the user already made. The transcript is
 * not read at all in that case, so the common steady state costs nothing.
 */
export async function withConversationRanks(
    session: SessionRecord,
    options: readonly WorkbenchRootOption[],
    read?: (
        session: SessionRecord,
    ) => Promise<{ branches: readonly string[]; directories: readonly string[] }>,
): Promise<WorkbenchRootOption[]> {
    const current = options.find((option) => option.projectId === session.workbenchRootProjectId);
    if (!read || !current?.isMain) return [...options];
    let ranked: Map<string, number>;
    try {
        ranked = rankConversationWorktrees(options, await read(session));
    } catch {
        // A menu that opens without its shortcut is fine; a menu that fails to open is not.
        return [...options];
    }
    return options.map((option) => {
        const rank = ranked.get(option.worktreeId);
        return rank === undefined ? option : { ...option, conversationRank: rank };
    });
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
                        title: project?.title ?? basename(worktree.rootPath),
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
