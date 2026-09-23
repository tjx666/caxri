import { lstat } from 'node:fs/promises';

import type { FileMutationOperation } from '@caxri/protocol';
import { errorMessage, isCaxriError } from '@caxri/protocol';

export function cloneOperation(operation: FileMutationOperation): FileMutationOperation {
    return structuredClone(operation);
}

export function operationFailure(error: unknown): { code: string; message: string } {
    return {
        code:
            (isCaxriError(error) ? error.code : undefined) ??
            (error as NodeJS.ErrnoException).code ??
            'IO',
        message: errorMessage(error, 'File operation failed'),
    };
}

export async function pathKind(path: string): Promise<'file' | 'directory' | undefined> {
    try {
        const stats = await lstat(path);
        if (stats.isSymbolicLink()) return undefined;
        if (stats.isFile()) return 'file';
        if (stats.isDirectory()) return 'directory';
        return undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

export async function pathIdentity(
    path: string,
): Promise<
    { birthtime: string; device: string; inode: string; kind: 'file' | 'directory' } | undefined
> {
    try {
        const stats = await lstat(path, { bigint: true });
        if (stats.isSymbolicLink()) return undefined;
        const kind = stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : undefined;
        if (!kind) return undefined;
        return {
            birthtime: stats.birthtimeNs.toString(),
            device: stats.dev.toString(),
            inode: stats.ino.toString(),
            kind,
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}
