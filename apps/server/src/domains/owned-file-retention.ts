import type { Dirent } from 'node:fs';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Retention for a Caxri-owned directory of generated files (saved long pastes, Session conversation references).
 */
export interface OwnedFileRetention {
    /**
     * Only regular files whose name matches are ever considered, so a file the user dropped into the directory, or a
     * symlink planted there, is never deleted.
     */
    fileName: RegExp;
    maxBytes: number;
    retentionMs: number;
}

interface OwnedFile {
    modifiedAt: number;
    path: string;
    size: number;
}

/**
 * Removes expired files, then the oldest remaining ones until `reserveBytes` more fit under the byte cap. Best-effort:
 * a missing directory, or a file another cleanup already removed, is not an error.
 */
export async function pruneOwnedFiles(
    directory: string,
    retention: OwnedFileRetention,
    now: number,
    reserveBytes: number,
): Promise<void> {
    let entries: Array<Dirent<string>>;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch {
        return;
    }
    const files: OwnedFile[] = [];
    for (const entry of entries) {
        if (!entry.isFile() || !retention.fileName.test(entry.name)) continue;
        const path = join(directory, entry.name);
        try {
            // eslint-disable-next-line no-await-in-loop -- every candidate must be revalidated before cleanup
            const stats = await lstat(path);
            if (!stats.isFile() || stats.isSymbolicLink()) continue;
            if (now - stats.mtimeMs >= retention.retentionMs) {
                // eslint-disable-next-line no-await-in-loop -- bounded, known files are removed before size accounting
                await unlink(path);
                continue;
            }
            files.push({ modifiedAt: stats.mtimeMs, path, size: stats.size });
        } catch {
            // A concurrent cleanup or external deletion is harmless.
        }
    }
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const oldestFirst = files.toSorted((a, b) => a.modifiedAt - b.modifiedAt);
    for (const file of oldestFirst) {
        if (totalBytes + reserveBytes <= retention.maxBytes) break;
        try {
            // eslint-disable-next-line no-await-in-loop -- deletion order preserves the newest references
            await unlink(file.path);
            totalBytes -= file.size;
        } catch {
            // A concurrent cleanup or external deletion is harmless.
        }
    }
}

/**
 * Compact UTC timestamp for a generated file name (`20261011T093000`), sortable and free of `:`.
 */
export function ownedFileTimestamp(now: number): string {
    return new Date(now).toISOString().replaceAll(/[-:]/g, '').slice(0, 15);
}
