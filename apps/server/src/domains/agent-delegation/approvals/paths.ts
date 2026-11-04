import { isAbsolute, relative } from 'node:path';

import { CaxriError, MAX_APPROVAL_PATHS_IN_REPLY } from '@caxri/protocol';

import type { PathVerdict } from './coverage';

/**
 * Resolves one path against a Session's authorized root, following workspace links (`ProjectRootResolver`).
 */
export type WorkspacePathResolver = (
    sessionId: string,
    path: string,
) => Promise<{ root: string; workspacePath?: string }>;

/**
 * Longest path the request projection keeps; a path this long may have been clipped.
 */
const PROJECTION_PATH_CAP = 4096;

/**
 * Whether every path of a file-change request lies inside the Session's authorized root. The verdict is a function of
 * the paths and the filesystem now, and is asked once per request version. `absent` is no usable list, `unproven` a
 * list this check cannot vouch for (too long, clipped, relative, missing on disk, or not resolvable), `outside` a path
 * the resolver denies. A nonexistent path is `unproven`, so a write that creates a file is never covered. The physical
 * target a link resolves to is never used as authority: only the workspace entry is.
 */
export async function pathVerdict(
    resolve: WorkspacePathResolver,
    sessionId: string,
    paths: readonly string[] | undefined,
): Promise<Exclude<PathVerdict, 'pending'>> {
    if (!paths || paths.length === 0) return 'absent';
    if (paths.length > MAX_APPROVAL_PATHS_IN_REPLY) return 'unproven';
    if (paths.some((path) => path.length >= PROJECTION_PATH_CAP || !isAbsolute(path)))
        return 'unproven';
    let verdict: 'inside' | 'unproven' = 'inside';
    for (const path of paths)
        try {
            // react-doctor-disable-next-line react-doctor/async-await-in-loop -- bounded by the path cap
            const { root, workspacePath } = await resolve(sessionId, path); // eslint-disable-line no-await-in-loop -- sequential: the first denied path decides
            const offset = workspacePath === undefined ? undefined : relative(root, workspacePath);
            if (offset === undefined || offset.startsWith('..') || isAbsolute(offset))
                verdict = 'unproven';
        } catch (error) {
            if (error instanceof CaxriError && error.code === 'PATH_DENIED') return 'outside';
            verdict = 'unproven';
        }
    return verdict;
}
