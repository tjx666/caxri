import type { Dirent } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Directories where Caxri Bot writes one brief per delegation (`tasks/`) and one report per ready pull request
 * (`reports/`), as its instructions ask.
 */
const BOT_TASK_FILE_DIRECTORIES = ['tasks', 'reports'] as const;

/**
 * A missing task directory has nothing to clear.
 */
async function readDirectoryNames(path: string): Promise<string[]> {
    try {
        return await readdir(path);
    } catch {
        return [];
    }
}

/**
 * A task directory replaced by a link or a file is one workspace entry to count and unlink. Listing or emptying it as a
 * folder would follow the link to a folder outside the workspace.
 */
async function taskDirectoryState(path: string): Promise<'folder' | 'entry' | 'missing'> {
    try {
        return (await lstat(path)).isDirectory() ? 'folder' : 'entry';
    } catch {
        return 'missing';
    }
}

/**
 * Walks a folder by hand instead of `readdir({ recursive: true })`, which follows symlinked folders on Node 26 and
 * would count files outside the workspace. An unreadable folder contributes nothing.
 */
async function listEntriesWithoutFollowingLinks(path: string): Promise<string[]> {
    let entries: Dirent[];
    try {
        entries = await readdir(path, { withFileTypes: true });
    } catch {
        return [];
    }
    const nested = await Promise.all(
        entries.map(async (entry) =>
            entry.isDirectory()
                ? listEntriesWithoutFollowingLinks(join(path, entry.name))
                : [join(path, entry.name)],
        ),
    );
    return nested.flat();
}

/**
 * Lists the regular files under the task directories. A symlink is counted as one entry and never followed, so the
 * count and a later delete stay inside the workspace.
 */
export async function listTaskFiles(
    workspacePath: string,
): Promise<Array<{ path: string; bytes: number }>> {
    const listed = await Promise.all(
        BOT_TASK_FILE_DIRECTORIES.map(async (directory) => {
            const path = join(workspacePath, directory);
            const state = await taskDirectoryState(path);
            if (state !== 'folder') return state === 'entry' ? [path] : [];
            return listEntriesWithoutFollowingLinks(path);
        }),
    );
    return Promise.all(
        listed.flat().map(async (path) => {
            try {
                return { path, bytes: (await lstat(path)).size };
            } catch {
                // Removed between the listing and the size read: it no longer takes any space.
                return { path, bytes: 0 };
            }
        }),
    );
}

/**
 * Empties the task directories and returns how many files went. Only their contents are removed; `rm` unlinks a
 * symlinked entry without following it, and a task directory that is itself a link is unlinked rather than emptied, so
 * nothing outside the workspace is touched.
 */
export async function clearBotTaskFiles(workspacePath: string): Promise<number> {
    const count = (await listTaskFiles(workspacePath)).length;
    await Promise.all(
        BOT_TASK_FILE_DIRECTORIES.map(async (directory) => {
            const path = join(workspacePath, directory);
            if ((await taskDirectoryState(path)) === 'entry') {
                await rm(path, { force: true });
                return;
            }
            const entries = await readDirectoryNames(path);
            await Promise.all(
                entries.map((entry) => rm(join(path, entry), { force: true, recursive: true })),
            );
        }),
    );
    return count;
}
