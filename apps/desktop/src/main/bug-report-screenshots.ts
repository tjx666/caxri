import { lstat, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const BUG_REPORT_SCREENSHOT_DIRECTORY = 'caxri-bug-reports';
const BUG_REPORT_SCREENSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Only Caxri's own screenshot files are pruning candidates. The directory lives in the world-writable OS temp root, so
 * anything else in it (a foreign file, a directory, a symlink someone planted at a Caxri-shaped name) is not ours to
 * delete.
 */
const BUG_REPORT_SCREENSHOT_NAME = /^caxri-bug-report-.*\.jpg$/;
/**
 * Bounds the work one save may do. Twenty-four hours of normal use produces a handful of files; a directory large
 * enough to exceed this is already anomalous, and stalling the save to walk it would be the worse failure.
 */
const MAX_BUG_REPORT_SCREENSHOT_CANDIDATES = 200;

function fileSystemErrorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

/**
 * Drops Caxri-owned screenshots older than a day so an abandoned or repeated report never accumulates unredacted
 * captures in the OS temp directory. Best effort by design: the current report must still be saved when the directory
 * cannot be read or a sibling window already removed an entry, so every failure is swallowed. `lstat` plus `isFile()`
 * is what keeps a symlink or a directory wearing a Caxri-shaped name from being followed and removed.
 */
export async function pruneBugReportScreenshots(directoryPath: string): Promise<void> {
    const expiresBefore = Date.now() - BUG_REPORT_SCREENSHOT_MAX_AGE_MS;
    let candidates = 0;
    try {
        const directory = await opendir(directoryPath);
        for await (const entry of directory) {
            if (candidates >= MAX_BUG_REPORT_SCREENSHOT_CANDIDATES) break;
            if (!BUG_REPORT_SCREENSHOT_NAME.test(entry.name)) continue;
            candidates += 1;
            const path = join(directoryPath, entry.name);
            try {
                const stats = await lstat(path);
                if (stats.isFile() && stats.mtimeMs < expiresBefore)
                    await rm(path, { force: true });
            } catch (error) {
                // A concurrent report may have removed the same expired file already.
                if (fileSystemErrorCode(error) !== 'ENOENT') throw error;
            }
        }
    } catch {
        /**
         * Pruning is housekeeping, never a precondition for saving this report.
         */
    }
}
