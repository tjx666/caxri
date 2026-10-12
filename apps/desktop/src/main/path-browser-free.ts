import type { Dirent } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { CaxriError, MAX_FILE_BROWSE_ENTRIES } from '@caxri/protocol';

import { readExternalFile } from './external-file-snapshot';
import type { RootIdentity } from './path-browser-identity';
import { pathFailure, validateDirectory } from './path-browser-identity';

/**
 * Free-mode reads: a bounded, read-only listing of this Mac's disk outside every Project authority. Only a local
 * Workbench reaches them; an SSH Host window's browser stays inside its Project (see `PathBrowserDirectories`).
 */

export interface FreeEntry {
    kind: 'directory' | 'file' | 'symlink';
    name: string;
    path: string;
    snapshot: { device: string; inode: string };
}

interface ResolvedBrowseInput {
    directory: string;
    filter: string;
}

const MAX_SCANNED_ENTRIES = 4_096;

/**
 * Splits a complete POSIX input into the directory to enumerate and its final refinement without performing shell
 * expansion. Relative input always resolves from the last explicitly navigated directory, never from a prior live
 * refinement, so changing `..` to `../name` cannot accidentally climb twice. `userHome` is `undefined` where `~` names
 * nothing this browser may read (an SSH Host window), and such input is refused.
 */
export function resolveBrowseInput(
    value: string,
    origin: string,
    userHome: string | undefined,
): ResolvedBrowseInput {
    if (value.includes('\0')) throw new CaxriError('VALIDATION', 'Path contains a null byte');
    if (/^\$(?:HOME|\{HOME\})(?:\/|$)/u.test(value))
        throw new CaxriError('VALIDATION', 'Shell path expansion is not supported');
    if (value !== '~' && value.startsWith('~') && !value.startsWith('~/'))
        throw new CaxriError('VALIDATION', 'Only current-user ~ paths are supported');
    if (!value) return { directory: origin, filter: '' };
    if (value === '~' || value.startsWith('~/')) {
        if (userHome === undefined)
            // PATH_DENIED, not UNAVAILABLE: the Renderer reads UNAVAILABLE as "Caxri is not ready yet".
            throw new CaxriError('PATH_DENIED', 'Home paths are not available in this window');
        if (value === '~' || value === '~/') return { directory: userHome, filter: '' };
    }

    const inputPath =
        userHome !== undefined && value.startsWith('~/')
            ? resolve(userHome, value.slice(2))
            : isAbsolute(value)
              ? resolve(value)
              : resolve(origin, value);
    const lastSegment = value.split('/').at(-1);
    const namesDirectory =
        value.endsWith('/') || lastSegment === '.' || lastSegment === '..' || value === '/';
    return namesDirectory
        ? { directory: inputPath, filter: '' }
        : { directory: dirname(inputPath), filter: basename(inputPath) };
}

export async function readFreeDocument(
    parent: RootIdentity | undefined,
    path: string,
    name: string,
    snapshot: FreeEntry['snapshot'] | undefined,
) {
    if (!parent || !snapshot)
        throw new CaxriError('PATH_DENIED', 'External browse entry is no longer available');
    return {
        opened: true as const,
        kind: 'external' as const,
        document: await readExternalFile(parent, path, name, snapshot),
    };
}

/**
 * Lists `directory` with its entries' own `lstat`, never following a link target for display metadata, sorted
 * directories first and bounded to one page.
 */
export async function listFreeDirectory(
    directory: RootIdentity,
    filter: string,
): Promise<{ entries: FreeEntry[]; isTruncated: boolean }> {
    await validateDirectory(directory);
    const normalizedFilter = filter.toLocaleLowerCase();
    const entries: FreeEntry[] = [];
    let scanned = 0;
    let isReachedEnd = false;
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
        handle = await opendir(directory.path);
    } catch (error) {
        return pathFailure(error, 'Unable to read browse directory');
    }
    try {
        while (scanned < MAX_SCANNED_ENTRIES && entries.length <= MAX_FILE_BROWSE_ENTRIES) {
            let entry: Dirent<string> | null;
            try {
                // eslint-disable-next-line no-await-in-loop -- a directory handle exposes one sequential cursor
                entry = await handle.read();
            } catch (error) {
                return pathFailure(error, 'Unable to read browse directory');
            }
            if (!entry) {
                isReachedEnd = true;
                break;
            }
            scanned += 1;
            if (!entry.name.toLocaleLowerCase().includes(normalizedFilter)) continue;
            const path = resolve(directory.path, entry.name);
            let stats: Awaited<ReturnType<typeof lstat>>;
            try {
                // eslint-disable-next-line no-await-in-loop -- only the bounded displayed page receives identities
                stats = await lstat(path, { bigint: true });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                return pathFailure(error, 'Unable to inspect browse entry');
            }
            entries.push({
                kind: stats.isSymbolicLink()
                    ? 'symlink'
                    : stats.isDirectory()
                      ? 'directory'
                      : 'file',
                name: entry.name,
                path,
                snapshot: { device: stats.dev.toString(), inode: stats.ino.toString() },
            });
        }
    } finally {
        try {
            await handle.close();
        } catch {
            // The bounded directory handle is discarded regardless; a close failure cannot expand access.
        }
    }
    await validateDirectory(directory);
    return {
        entries: entries
            .toSorted((left, right) => {
                if (left.kind === 'directory' && right.kind !== 'directory') return -1;
                if (left.kind !== 'directory' && right.kind === 'directory') return 1;
                return left.name.localeCompare(right.name);
            })
            .slice(0, MAX_FILE_BROWSE_ENTRIES),
        isTruncated: !isReachedEnd || entries.length > MAX_FILE_BROWSE_ENTRIES,
    };
}
