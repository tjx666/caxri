import type { Dirent } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Lists what is left under a directory as relative paths with a type marker (`/` for directories), never reading file
 * contents. Used to name the late writer when cleanup fails.
 */
export async function listResidualEntries(root: string, limit = 50): Promise<string[]> {
    const found: string[] = [];
    const walk = async (directory: string): Promise<void> => {
        let entries: Dirent[];
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (found.length >= limit) return;
            const path = join(directory, entry.name);
            found.push(`${relative(root, path)}${entry.isDirectory() ? '/' : ''}`);
            // eslint-disable-next-line no-await-in-loop -- sequential walk keeps output order and the limit exact
            if (entry.isDirectory()) await walk(path);
        }
    };
    await walk(root);
    return found;
}

/**
 * Removes a temporary test directory. When removal fails (typically ENOTEMPTY because a writer outlived its owner), the
 * error message carries the residual relative paths so the second writer can be identified from the filename instead of
 * masking it with a retry.
 */
export async function removeTestDirectory(directory: string): Promise<void> {
    try {
        await rm(directory, { recursive: true, force: true });
    } catch (error) {
        const residual = await listResidualEntries(directory);
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Failed to remove test directory (${reason}); residual entries: ${JSON.stringify(residual)}`,
            { cause: error },
        );
    }
}
