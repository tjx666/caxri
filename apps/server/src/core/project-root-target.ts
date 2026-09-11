import { lstat, realpath } from 'node:fs/promises';
import { basename } from 'node:path';

import type { ProjectRecord, ServerOperationResult } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

/**
 * Captures a stored Project root without borrowing a Session's worktree authority.
 */
export async function authorizeProjectRoot(
    project: ProjectRecord,
): Promise<ServerOperationResult<'files.authorizeOpen'>> {
    const path = project.rootPath;
    const before = await lstat(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || (await realpath(path)) !== path)
        throw new CaxriError('PATH_DENIED', 'Project root changed after it was selected');
    const after = await lstat(path, { bigint: true });
    if (
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        before.dev !== after.dev ||
        before.ino !== after.ino
    )
        throw new CaxriError('CONFLICT', 'Project root changed during authorization');
    const identity = { path, device: after.dev.toString(), inode: after.ino.toString() };
    return { ...identity, root: identity, kind: 'directory', name: basename(path) };
}
