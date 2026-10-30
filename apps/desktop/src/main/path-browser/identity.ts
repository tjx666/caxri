import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { CaxriError } from '@caxri/protocol';

export interface RootIdentity {
    path: string;
    device: string;
    inode: string;
}

export interface FileIdentity {
    device: string;
    inode: string;
    root: RootIdentity;
}

export interface EntrySnapshot {
    device: string;
    inode: string;
}

export function isSameOrInside(root: string, target: string): boolean {
    const pathFromRoot = relative(root, target);
    return (
        pathFromRoot === '' ||
        (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
    );
}

export function pathFailure(error: unknown, fallback: string): never {
    if (error instanceof CaxriError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
        throw new CaxriError('NOT_FOUND', 'File not found');
    if (code === 'EACCES' || code === 'EPERM')
        throw new CaxriError('PATH_DENIED', 'Path is not accessible');
    /**
     * Native filesystem errors include the raw absolute path. Path-browser locations stay Main-owned, so only a stable
     * content-free failure may cross IPC or enter diagnostics.
     */
    throw new CaxriError('IO', fallback);
}

export async function directoryIdentity(
    path: string,
    shouldFollowWorkspaceLinks = false,
): Promise<RootIdentity> {
    try {
        const workspacePath = resolve(path);
        if (shouldFollowWorkspaceLinks) path = await realpath(path);
        const before = await lstat(path, { bigint: true });
        // Separate messages because the two refusals need different fixes: a symlinked location has to be reached
        // through its canonical path, while a file simply cannot be browsed. Reporting `/tmp` (a link to
        // `/private/tmp` on macOS) as "not a directory" sent readers looking for a missing file that was there.
        if (before.isSymbolicLink())
            throw new CaxriError('PATH_DENIED', 'Browse location is a symbolic link');
        if (!before.isDirectory())
            throw new CaxriError('PATH_DENIED', 'Browse location is not a directory');
        const canonicalPath = await realpath(path);
        const after = await lstat(path, { bigint: true });
        if (
            after.isSymbolicLink() ||
            !after.isDirectory() ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            (await realpath(path)) !== canonicalPath
        )
            throw new CaxriError('CONFLICT', 'Browse location changed during authorization');
        return {
            path: shouldFollowWorkspaceLinks ? workspacePath : canonicalPath,
            device: after.dev.toString(),
            inode: after.ino.toString(),
        };
    } catch (error) {
        return pathFailure(error, 'Unable to inspect browse location');
    }
}

export async function validateDirectory(directory: RootIdentity): Promise<void> {
    try {
        const current = await lstat(directory.path, { bigint: true });
        if (
            current.isSymbolicLink() ||
            !current.isDirectory() ||
            current.dev.toString() !== directory.device ||
            current.ino.toString() !== directory.inode ||
            (await realpath(directory.path)) !== directory.path
        )
            throw new CaxriError('CONFLICT', 'Browse location changed after it was listed');
    } catch (error) {
        return pathFailure(error, 'Unable to validate browse location');
    }
}

export async function authorizeCandidate(
    parent: RootIdentity,
    candidatePath: string,
    expected?: EntrySnapshot,
): Promise<{ identity: FileIdentity; kind: 'directory' | 'file'; path: string }> {
    await validateDirectory(parent);
    try {
        const lexicalStats = await lstat(candidatePath, { bigint: true });
        if (lexicalStats.isSymbolicLink())
            throw new CaxriError('PATH_DENIED', 'Symbolic links cannot be opened');
        if (
            expected &&
            (expected.device !== lexicalStats.dev.toString() ||
                expected.inode !== lexicalStats.ino.toString())
        )
            throw new CaxriError('CONFLICT', 'Path changed after it was listed');
        const canonicalPath = await realpath(candidatePath);
        if (!isSameOrInside(parent.path, canonicalPath) || dirname(canonicalPath) !== parent.path)
            throw new CaxriError('PATH_DENIED', 'Path escapes its listed directory');
        const stats = await lstat(canonicalPath, { bigint: true });
        if (
            stats.isSymbolicLink() ||
            stats.dev !== lexicalStats.dev ||
            stats.ino !== lexicalStats.ino
        )
            throw new CaxriError('CONFLICT', 'Path changed during authorization');
        if (!stats.isDirectory() && !stats.isFile())
            throw new CaxriError('VALIDATION', 'Path is not a regular file or directory');
        await validateDirectory(parent);
        return {
            identity: {
                device: stats.dev.toString(),
                inode: stats.ino.toString(),
                root: parent,
            },
            kind: stats.isDirectory() ? 'directory' : 'file',
            path: canonicalPath,
        };
    } catch (error) {
        return pathFailure(error, 'Unable to authorize browse entry');
    }
}
