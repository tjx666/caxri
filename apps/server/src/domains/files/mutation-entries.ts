import { Buffer } from 'node:buffer';
import { lstat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';

import type { ServerOperationResult } from '@caxri/protocol';
import { CaxriError, isCaxriError } from '@caxri/protocol';

import type { FileIdentity } from './mutations-copy';

export const MAX_UNIQUE_NAME_ATTEMPTS = 100;
const MAX_FILE_NAME_BYTES = 255;

export interface ResolvedMutableEntry extends ServerOperationResult<'files.create'>, FileIdentity {
    root: FileIdentity;
}

export function fileName(name: string): string {
    const normalized = name.trim();
    if (
        !normalized ||
        normalized === '.' ||
        normalized === '..' ||
        normalized.length > 255 ||
        normalized.includes('/') ||
        normalized.includes('\\') ||
        normalized.includes('\0') ||
        Buffer.byteLength(normalized) > MAX_FILE_NAME_BYTES
    )
        throw new CaxriError('VALIDATION', 'Enter a valid file name without path separators');
    return normalized;
}

export function suffixedName(source: ResolvedMutableEntry, sequence: number): string {
    if (sequence === 0) return source.name;
    const extension = source.kind === 'file' ? extname(source.name) : '';
    const stem = extension ? source.name.slice(0, -extension.length) : source.name;
    const suffix = sequence === 1 ? ' copy' : ` copy ${sequence}`;
    const tail = `${suffix}${extension}`;
    const availableBytes = MAX_FILE_NAME_BYTES - Buffer.byteLength(tail);
    if (availableBytes < 1)
        throw new CaxriError('VALIDATION', 'File name is too long to create a unique copy');
    let boundedStem = '';
    for (const character of stem) {
        if (Buffer.byteLength(boundedStem + character) > availableBytes) break;
        boundedStem += character;
    }
    return `${boundedStem || 'item'}${tail}`;
}

export function mutationError(error: unknown, action: string): CaxriError {
    if (isCaxriError(error)) return error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return new CaxriError('NOT_FOUND', 'File or folder no longer exists');
    if (code === 'EEXIST' || code === 'ENOTEMPTY')
        return new CaxriError('CONFLICT', 'A file or folder with that name already exists');
    if (code === 'EACCES' || code === 'EPERM')
        return new CaxriError('PATH_DENIED', `Permission denied while ${action}`);
    // `rename(2)` cannot cross filesystems; moving between Projects on different volumes needs a copy instead.
    if (code === 'EXDEV')
        return new CaxriError('IO', 'Items cannot be moved between disks; copy them instead');
    return new CaxriError('IO', `Unable to ${action}`);
}

/**
 * Resolves a file or folder the user dropped or pasted from Finder, which lies outside every Project and is only ever
 * read. It gets the same entry checks as a Project source (no symbolic link, no hard-linked file, only regular files
 * and folders); its parent directory stands in for the Project root, which nothing about an external source uses beyond
 * naming it relative to that parent in logs.
 */
export async function resolveExternalEntry(input: string): Promise<ResolvedMutableEntry> {
    if (!isAbsolute(input))
        throw new CaxriError('VALIDATION', 'An external source must be an absolute path');
    const path = resolve(input);
    const [stats, parentStats] = await Promise.all([
        lstat(path, { bigint: true }),
        lstat(dirname(path), { bigint: true }),
    ]);
    if (
        stats.isSymbolicLink() ||
        (stats.isFile() && stats.nlink > 1n) ||
        (!stats.isFile() && !stats.isDirectory())
    )
        throw new CaxriError('PATH_DENIED', 'Only regular files and folders can be copied');
    return {
        root: {
            path: dirname(path),
            device: parentStats.dev.toString(),
            inode: parentStats.ino.toString(),
        },
        path,
        name: basename(path),
        kind: stats.isDirectory() ? 'directory' : 'file',
        birthtime: stats.birthtimeNs.toString(),
        device: stats.dev.toString(),
        inode: stats.ino.toString(),
    };
}
