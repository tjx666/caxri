import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';

/**
 * True when the path exists as any entry type (symlinks are not followed, so a dangling link still counts as existing).
 * Non-ENOENT failures propagate: an unreadable parent must surface as an error instead of reading as "does not exist".
 */
export async function isExistingPath(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

/**
 * True when the path exists and grants the given access mode (`fs.constants.X_OK`, `R_OK`, …). Any failure reads as
 * inaccessible; use `isExistingPath` when non-ENOENT errors must propagate.
 */
export async function isAccessible(path: string, mode: number = constants.F_OK): Promise<boolean> {
    try {
        await access(path, mode);
        return true;
    } catch {
        return false;
    }
}
