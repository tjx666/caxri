import type { Dirent, Stats } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import type { ServerOperationParameters, ServerOperationResult } from '@caxri/protocol';
import { CaxriError, PROJECT_BROWSE_FOLDERS_MAX_ENTRIES } from '@caxri/protocol';

import type { DomainHandlers } from '../domain-services';

type BrowseParameters = ServerOperationParameters<'project.browseFolders'>;
type BrowseResult = ServerOperationResult<'project.browseFolders'>;
type BrowseEntry = BrowseResult['entries'][number];

/**
 * Upper bound for probing one listed folder. Children of `/` include automount points (`/home`, `/net`) and `/Volumes`
 * entries whose `stat` can block on an unreachable network share; one slow child must not hold the whole listing
 * hostage.
 */
const ENTRY_PROBE_TIMEOUT_MS = 1500;

async function statOrUndefined(path: string): Promise<Stats | undefined> {
    try {
        return await stat(path);
    } catch {
        return undefined;
    }
}

/**
 * Whether a folder is a Git repository root; `.git` may be a directory or a worktree's gitdir file.
 */
export async function isGitRepoRoot(path: string): Promise<boolean> {
    return (await statOrUndefined(join(path, '.git'))) !== undefined;
}

/**
 * Whether a folder has at least one visible (non-dot) child directory, so a browser can offer to expand it.
 */
export async function hasVisibleChildDirectory(path: string): Promise<boolean> {
    let children: Dirent[];
    try {
        children = await readdir(path, { withFileTypes: true });
    } catch {
        return false;
    }
    return children.some(
        (entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()),
    );
}

/**
 * Reads one folder's Git and expand hints. A probe that misses the deadline still lists a real directory, without the
 * Git badge and as expandable, so the user can open it and find out.
 */
async function probeEntry(
    directory: string,
    entry: Dirent,
    timeoutMs: number,
): Promise<BrowseEntry | undefined> {
    const path = join(directory, entry.name);
    const probe = (async (): Promise<BrowseEntry | undefined> => {
        if (!(await statOrUndefined(path))?.isDirectory()) return;
        const [isGitRepo, hasChildren] = await Promise.all([
            isGitRepoRoot(path),
            hasVisibleChildDirectory(path),
        ]);
        return { name: entry.name, path, isGitRepository: isGitRepo, hasChildren };
    })();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<BrowseEntry | undefined>((resolve) => {
        timer = setTimeout(
            () =>
                resolve(
                    entry.isDirectory()
                        ? { name: entry.name, path, isGitRepository: false, hasChildren: true }
                        : undefined,
                ),
            timeoutMs,
        );
    });
    try {
        return await Promise.race([probe, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Lists visible subfolders of one absolute directory for choosing a Project root. Unlike the mobile browser this is not
 * confined to the home directory: it serves the Desktop principal of the Server's own machine, which may keep
 * repositories under `/srv` or `/data`. It only reads names and folder metadata; adding a Project still goes through
 * `project.create`, which canonicalizes the root itself.
 */
export function createProjectFolderBrowser(
    options: {
        homeDirectory?: () => Promise<string>;
        /**
         * Per-folder probe deadline; tests shorten it.
         */
        entryProbeTimeoutMs?: number;
    } = {},
): Pick<DomainHandlers, 'project.browseFolders'> {
    const resolveHome = options.homeDirectory ?? (() => realpath(homedir()));
    const entryProbeTimeoutMs = options.entryProbeTimeoutMs ?? ENTRY_PROBE_TIMEOUT_MS;
    return {
        'project.browseFolders': async ({ path }: BrowseParameters): Promise<BrowseResult> => {
            const home = await resolveHome();
            if (path !== undefined && !isAbsolute(path))
                throw new CaxriError('VALIDATION', 'Folder path must be absolute');
            let directory: string;
            try {
                directory = await realpath(path ?? home);
            } catch {
                throw new CaxriError('NOT_FOUND', 'Folder does not exist');
            }
            if (!(await statOrUndefined(directory))?.isDirectory())
                throw new CaxriError('PATH_DENIED', 'Path is not a folder');
            let children: Dirent[];
            try {
                children = await readdir(directory, { withFileTypes: true });
            } catch {
                throw new CaxriError('PATH_DENIED', 'Folder cannot be listed');
            }
            const candidates = children
                .filter(
                    (entry) =>
                        !entry.name.startsWith('.') &&
                        (entry.isDirectory() || entry.isSymbolicLink()),
                )
                .toSorted((left, right) => left.name.localeCompare(right.name));
            const entries = await Promise.all(
                candidates
                    .slice(0, PROJECT_BROWSE_FOLDERS_MAX_ENTRIES)
                    .map((entry) => probeEntry(directory, entry, entryProbeTimeoutMs)),
            );
            const parent = dirname(directory);
            return {
                path: directory,
                parent: parent === directory ? null : parent,
                home,
                entries: entries.filter((entry) => entry !== undefined),
                truncated: candidates.length > PROJECT_BROWSE_FOLDERS_MAX_ENTRIES,
            };
        },
    };
}
