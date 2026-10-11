import type { Dirent, Stats } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

import type {
    ServerEvent,
    ServerOperationParameters,
    ServerOperationResult,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import { resolveOwnerProjectRoot } from '../project';

type BrowseParameters = Omit<
    ServerOperationParameters<'mobile.project.browseInternal'>,
    'principal'
>;
type BrowseResult = ServerOperationResult<'mobile.project.browseInternal'>;
type AddParameters = Omit<ServerOperationParameters<'mobile.project.addInternal'>, 'principal'>;
type AddResult = ServerOperationResult<'mobile.project.addInternal'>;

const MAX_BROWSE_ENTRIES = 200;

async function statOrUndefined(path: string): Promise<Stats | undefined> {
    try {
        return await stat(path);
    } catch {
        return undefined;
    }
}

/**
 * Resolves a mobile-submitted path to a canonical, symlink-followed absolute path and rejects anything that lands
 * outside the home directory. Both a `..` segment and a symlink whose target lives outside home are caught here,
 * because `realpath` follows both before the containment check runs.
 */
async function resolveWithinHome(
    homeDirectory: string,
    path: string | undefined,
): Promise<{ absolute: string; relativePath: string }> {
    const candidate =
        path === undefined ? homeDirectory : isAbsolute(path) ? path : join(homeDirectory, path);
    let canonical: string;
    try {
        canonical = await realpath(candidate);
    } catch {
        throw new CaxriError('PATH_DENIED', 'Directory does not exist');
    }
    if (canonical !== homeDirectory && !canonical.startsWith(homeDirectory + sep))
        throw new CaxriError('FORBIDDEN', 'Path is outside the home directory');
    const info = await statOrUndefined(canonical);
    if (!info?.isDirectory()) throw new CaxriError('PATH_DENIED', 'Path is not a directory');
    return { absolute: canonical, relativePath: relative(homeDirectory, canonical) };
}

async function isGitRepo(candidatePath: string): Promise<boolean> {
    try {
        await stat(join(candidatePath, '.git'));
        return true;
    } catch {
        return false;
    }
}

async function hasVisibleChildDirectory(candidatePath: string): Promise<boolean> {
    let children: Dirent[];
    try {
        children = await readdir(candidatePath, { withFileTypes: true });
    } catch {
        return false;
    }
    return children.some(
        (entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()),
    );
}

export function createMobileProjectBrowseHandler(options: {
    homeDirectory?: () => Promise<string>;
}) {
    const resolveHome = options.homeDirectory ?? (() => realpath(homedir()));
    return async ({ path }: BrowseParameters): Promise<BrowseResult> => {
        const homeDirectory = await resolveHome();
        const { absolute } = await resolveWithinHome(homeDirectory, path);
        let children: Dirent[];
        try {
            children = await readdir(absolute, { withFileTypes: true });
        } catch {
            throw new CaxriError('PATH_DENIED', 'Directory cannot be listed');
        }
        const candidates = children
            .filter(
                (entry) =>
                    !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()),
            )
            .toSorted((left, right) => left.name.localeCompare(right.name));
        const isTruncated = candidates.length > MAX_BROWSE_ENTRIES;
        const entries = await Promise.all(
            candidates.slice(0, MAX_BROWSE_ENTRIES).map(async (entry) => {
                const childPath = join(absolute, entry.name);
                const childStats = await statOrUndefined(childPath);
                if (!childStats?.isDirectory()) return;
                const [isRepo, hasChildren] = await Promise.all([
                    isGitRepo(childPath),
                    hasVisibleChildDirectory(childPath),
                ]);
                return {
                    name: entry.name,
                    relativePath: relative(homeDirectory, childPath),
                    isGitRepository: isRepo,
                    hasChildren,
                };
            }),
        );
        return {
            entries: entries.filter((entry) => entry !== undefined),
            truncated: isTruncated,
        };
    };
}

export function createMobileProjectAddHandler(options: {
    database: CaxriDatabase;
    emit: (event: ServerEvent) => void;
    homeDirectory?: () => Promise<string>;
}) {
    const resolveHome = options.homeDirectory ?? (() => realpath(homedir()));
    return async ({ path }: AddParameters): Promise<AddResult> => {
        const homeDirectory = await resolveHome();
        const { absolute } = await resolveWithinHome(homeDirectory, path);
        const rootPath = await resolveOwnerProjectRoot(absolute);
        /**
         * `database.createProject` is idempotent by root and un-hides a previously hidden Project on a manual add, so a
         * device re-adding an existing folder gets the same Project back instead of a duplicate row.
         */
        const project = options.database.createProject(rootPath);
        options.emit({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'project.create' },
        });
        return { project: { id: project.id, displayTitle: project.displayTitle } };
    };
}
