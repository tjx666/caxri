import { lstat, readFile } from 'node:fs/promises';

import type { FileMutationOperation } from '@caxri/protocol';
import {
    CaxriError,
    errorMessage,
    fileMutationOperationSchema,
    isCaxriError,
} from '@caxri/protocol';
import { z } from 'zod';

/**
 * Reads the durable journal. A missing file is a fresh profile. A journal that no longer matches the current schema
 * (for example a record from an older build without `workbenchProjectId`) is never partially trusted, because recovery
 * would act on records of unknown scope. Initialization fails instead, so every file mutation is refused before it
 * touches user files, while Server Core keeps running and the journal file is left in place.
 */
export async function readJournalRecords(
    path: string,
    maximum: number,
): Promise<FileMutationOperation[]> {
    try {
        return z
            .array(fileMutationOperationSchema)
            .max(maximum)
            .parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        if (error instanceof SyntaxError || error instanceof z.ZodError)
            throw new CaxriError(
                'VALIDATION',
                'File operation journal is unreadable; delete the file operation journal from the Server profile directory and retry',
            );
        throw error;
    }
}

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
