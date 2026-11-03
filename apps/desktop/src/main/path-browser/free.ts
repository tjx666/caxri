import type { Dirent } from 'node:fs';
import { lstat, opendir, readlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { CaxriError, MAX_FILE_BROWSE_ENTRIES } from '@caxri/protocol';

import { pathBrowserDenialDetails } from '../../shared/path-browser-denial';
import { readExternalFile } from '../external-documents/snapshot';
import type { RootIdentity } from './identity';
import { directoryIdentity, pathFailure, validateDirectory } from './identity';

/**
 * Free-mode reads: a bounded, read-only listing of this Mac's disk outside every Project authority. Only a local
 * Workbench reaches them; an SSH Host window's browser stays inside its Project (see `PathBrowserDirectories`).
 */

export interface FreeEntry {
    kind: 'directory' | 'file' | 'symlink';
    /**
     * What a `symlink` row currently points at, for its icon and Enter affordance only. Opening re-resolves the link
     * (see `resolveFreeLink` in `authority.ts`), so this display metadata never authorizes a later request.
     */
    linkKind?: 'broken' | 'directory' | 'file';
    linkTarget?: string;
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
            throw new CaxriError(
                'PATH_DENIED',
                'Home paths are not available in this window',
                pathBrowserDenialDetails('homeUnavailable'),
            );
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
                // eslint-disable-next-line no-await-in-loop -- only the bounded displayed page probes link targets
                ...(stats.isSymbolicLink() && (await probeLink(path))),
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
                const isLeftDirectory = isDirectoryLike(left);
                if (isLeftDirectory !== isDirectoryLike(right)) return isLeftDirectory ? -1 : 1;
                return left.name.localeCompare(right.name);
            })
            .slice(0, MAX_FILE_BROWSE_ENTRIES),
        isTruncated: !isReachedEnd || entries.length > MAX_FILE_BROWSE_ENTRIES,
    };
}

/**
 * A linked folder sorts with folders, matching the Files tree, so `~/.agents/skills/` does not split its skills into
 * two runs by whether each one is a link.
 */
function isDirectoryLike(entry: FreeEntry): boolean {
    return (
        entry.kind === 'directory' || (entry.kind === 'symlink' && entry.linkKind === 'directory')
    );
}

/**
 * Display-only target probe for a listed link. Any failure (a dangling or looping link, a target the user cannot read)
 * reads as `broken`; the row stays openable and a real open reports the actual failure.
 */
async function probeLink(path: string): Promise<Pick<FreeEntry, 'linkKind' | 'linkTarget'>> {
    let linkTarget: string | undefined;
    try {
        linkTarget = await readlink(path);
        const target = await stat(path);
        return {
            linkKind: target.isDirectory() ? 'directory' : 'file',
            linkTarget,
        };
    } catch {
        return { linkKind: 'broken', ...(linkTarget !== undefined && { linkTarget }) };
    }
}

/**
 * Re-resolves a link listed outside the Project to its current target, described as the entry its own directory would
 * list. Free browsing already reads any path the user types, so following a link there reaches nothing the user could
 * not type; refusing it only blocked layouts such as `~/.agents/skills/`, where every skill is a link. The link itself
 * must still be the entry that was listed.
 */
export async function followFreeLink(
    parent: RootIdentity | undefined,
    path: string,
    snapshot: FreeEntry['snapshot'] | undefined,
): Promise<
    Pick<FreeEntry, 'name' | 'path' | 'snapshot'> & {
        kind: 'directory' | 'file';
        parent: RootIdentity;
    }
> {
    if (!parent || !snapshot)
        throw new CaxriError('PATH_DENIED', 'Browse entry is no longer available');
    await validateDirectory(parent);
    try {
        const link = await lstat(path, { bigint: true });
        if (
            !link.isSymbolicLink() ||
            link.dev.toString() !== snapshot.device ||
            link.ino.toString() !== snapshot.inode
        )
            throw new CaxriError('CONFLICT', 'Path changed after it was listed');
        const targetPath = await realpath(path);
        const target = await lstat(targetPath, { bigint: true });
        if (!target.isDirectory() && !target.isFile())
            throw new CaxriError('VALIDATION', 'Path is not a regular file or directory');
        return {
            kind: target.isDirectory() ? 'directory' : 'file',
            name: basename(targetPath),
            parent: await directoryIdentity(dirname(targetPath)),
            path: targetPath,
            snapshot: { device: target.dev.toString(), inode: target.ino.toString() },
        };
    } catch (error) {
        return pathFailure(error, 'Unable to follow browse link');
    }
}
