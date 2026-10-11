import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import { assertInsideRoot, isOutsideRoot } from '../path-security';
import { isSameWorkbenchRootIdentity } from '../workbench';

/**
 * Accept alternate spellings of the Project root (such as macOS /var), without authorizing an outside leaf.
 */
async function workspaceEntryPath(root: string, candidate: string): Promise<string> {
    if (!isOutsideRoot(relative(root, candidate))) return resolve(candidate);
    if ((await realpath(candidate)) === root) return root;
    let ancestor = dirname(candidate);
    while (ancestor !== dirname(ancestor)) {
        // eslint-disable-next-line no-await-in-loop -- each ancestor establishes the next possible root spelling
        if ((await realpath(ancestor)) === root)
            return resolve(root, relative(ancestor, candidate));
        ancestor = dirname(ancestor);
    }
    throw new CaxriError('PATH_DENIED', 'Path is outside the Project root');
}

export interface ResolvedSessionPath {
    root: string;
    path: string;
    /**
     * Workspace entry identity, retained when a trusted link resolves to another location.
     */
    workspacePath?: string;
}

export interface ProjectRootResolverOptions {
    /**
     * Integration-test seam for a root replacement between the first metadata read and realpath.
     */
    beforeRootRealpath?: () => Promise<void>;
    /**
     * Integration-test seam for restoring a replaced root before the post-realpath identity read.
     */
    afterRootRealpath?: () => Promise<void>;
}

/**
 * Resolves a Session to its active Workbench Project root and validates Session-relative paths against it. New
 * Terminals and Agent launches also use this root as their default cwd while retaining independent durable records.
 *
 * This is the single place that turns a Session ID plus an optional relative or absolute path into a filesystem
 * location, so `FileService` and `GitService` share one TOCTOU-safe resolution instead of Git depending on the whole
 * `FileService` just to find a Session's root.
 */
export class ProjectRootResolver {
    constructor(
        private readonly database: CaxriDatabase,
        private readonly options: ProjectRootResolverOptions = {},
    ) {}

    /**
     * Captures the authorized root before a durable operation crosses an asynchronous boundary.
     */
    getSessionWorkbenchProjectId(sessionId: string): string {
        const binding = this.database.getSessionWorkbenchBinding(sessionId);
        if (!binding) throw new CaxriError('NOT_FOUND', 'Session not found');
        return binding.workbenchProjectId;
    }

    async resolveSessionPath(
        sessionId: string,
        input?: string,
        shouldFollowWorkspaceLinks = false,
    ): Promise<ResolvedSessionPath> {
        const session = this.database.getSession(sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        const binding = this.database.getSessionWorkbenchBinding(sessionId);
        if (!binding) throw new CaxriError('NOT_FOUND', 'Session not found');
        let root: string;
        try {
            const rootStats = await lstat(session.rootPath, { bigint: true });
            if (rootStats.isSymbolicLink() || !rootStats.isDirectory())
                throw new CaxriError('PATH_DENIED', 'Project root changed after it was selected');
            if (
                binding.workbenchProjectId !== binding.projectId &&
                !isSameWorkbenchRootIdentity(binding, { inode: rootStats.ino.toString() })
            )
                throw new CaxriError('PATH_DENIED', 'Workbench root changed after authorization');
            await this.options.beforeRootRealpath?.();
            root = await realpath(session.rootPath);
            await this.options.afterRootRealpath?.();
            const currentRootStats = await lstat(session.rootPath, { bigint: true });
            if (
                currentRootStats.isSymbolicLink() ||
                !currentRootStats.isDirectory() ||
                currentRootStats.dev !== rootStats.dev ||
                currentRootStats.ino !== rootStats.ino
            )
                throw new CaxriError('PATH_DENIED', 'Project root changed during authorization');
            if ((await realpath(session.rootPath)) !== root)
                throw new CaxriError('PATH_DENIED', 'Project root changed during authorization');
        } catch (error) {
            /**
             * A linked Workbench Root can disappear anywhere in the canonicalization sequence before Git topology
             * invalidation falls the Session back to its owner. Reads admitted against that generation are stale
             * control flow, not filesystem faults; owner-root failures retain their existing error classification.
             */
            if (
                (error as NodeJS.ErrnoException).code === 'ENOENT' &&
                binding.workbenchProjectId !== binding.projectId
            )
                throw new CaxriError('CANCELLED', 'Workbench root is no longer available');
            throw error;
        }
        const candidate = input && isAbsolute(input) ? resolve(input) : resolve(root, input ?? '.');
        let workspacePath: string | undefined;
        let resolved: string;
        try {
            workspacePath = shouldFollowWorkspaceLinks
                ? await workspaceEntryPath(root, candidate)
                : undefined;
            resolved = await realpath(candidate);
        } catch (error) {
            /**
             * A listing can still name the removed worktree after fallback selected its owner. Missing candidates are
             * expected filesystem state, not INTERNAL failures; root validation and containment remain separate.
             */
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                throw new CaxriError('NOT_FOUND', 'Requested path no longer exists');
            throw error;
        }
        /**
         * Explorer/editor links are trusted through their workspace entry, even when the target is outside the root.
         * Other domains keep canonical containment; never turn a returned physical target into a new entry authority.
         */
        if (shouldFollowWorkspaceLinks) return { root, path: resolved, workspacePath };
        assertInsideRoot(relative(root, resolved), 'Symlink target is outside the Project root');
        return { root, path: resolved };
    }

    /**
     * Returns durable Project roots that the user explicitly granted to Caxri.
     */
    listApprovedProjectRoots(): string[] {
        return this.database.listProjects().map((project) => project.rootPath);
    }
}
