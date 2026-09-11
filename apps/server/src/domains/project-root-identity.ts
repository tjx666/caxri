import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { CaxriError } from '@caxri/protocol';

interface ProjectRootIdentity {
    path: string;
    device: string;
    inode: string;
}

function changedRoot(): CaxriError {
    return new CaxriError('PATH_DENIED', 'Selected Project root changed before creation');
}

async function selectedRootStats(rootPath: string) {
    try {
        return await lstat(rootPath, { bigint: true });
    } catch {
        throw changedRoot();
    }
}

/**
 * Binds a native folder selection to the same filesystem object until the synchronous database insert. Without this
 * identity check, replacing the selected path between authorization and `project.create` could persist a Project for a
 * folder the user never selected.
 */
export async function resolveProjectRoot(
    rootPath: string,
    expectedIdentity?: ProjectRootIdentity,
): Promise<string> {
    if (!expectedIdentity) return realpath(rootPath);
    const before = await selectedRootStats(rootPath);
    if (
        before.isSymbolicLink() ||
        !before.isDirectory() ||
        before.dev.toString() !== expectedIdentity.device ||
        before.ino.toString() !== expectedIdentity.inode
    )
        throw changedRoot();

    let canonicalRoot: string;
    try {
        canonicalRoot = await realpath(rootPath);
    } catch {
        throw changedRoot();
    }
    const after = await selectedRootStats(rootPath);
    if (
        canonicalRoot !== expectedIdentity.path ||
        after.isSymbolicLink() ||
        !after.isDirectory() ||
        after.dev !== before.dev ||
        after.ino !== before.ino
    )
        throw changedRoot();
    return canonicalRoot;
}

/**
 * Explicit owner CLI paths use the same identity recheck as a native folder selection.
 */
export async function resolveOwnerProjectRoot(rootPath: string): Promise<string> {
    if (!isAbsolute(rootPath))
        throw new CaxriError(
            'PATH_DENIED',
            'Owner directory authorization requires an absolute path',
        );
    let path: string;
    try {
        path = await realpath(rootPath);
    } catch {
        throw new CaxriError(
            'PATH_DENIED',
            'Owner directory authorization requires an existing directory',
        );
    }
    const info = await selectedRootStats(path);
    if (!info.isDirectory())
        throw new CaxriError('PATH_DENIED', 'Owner directory authorization requires a directory');
    return resolveProjectRoot(path, {
        path,
        device: info.dev.toString(),
        inode: info.ino.toString(),
    });
}
