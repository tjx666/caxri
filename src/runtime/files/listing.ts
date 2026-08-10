import { lstat, readdir, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { CaxriError, errorMessage } from '../../shared/ipc/errors';
import {
    MAX_FILE_BROWSE_ENTRIES,
    type RuntimeMethodParams,
    type RuntimeMethodResult,
} from '../../shared/ipc/methods';
import { mapWithConcurrency } from '../../shared/node/concurrency';
import type { StructuredLogger } from '../../shared/node/logger';
import type { FileEntry } from '../../shared/types';
import { SingleFlight } from '../single-flight';
import type { ResolveSessionPath } from './documents';
import { matchesFileTreeExclude, type FileTreeExcludes } from './file-tree-excludes';

const MAX_CONCURRENT_ENTRY_STATS = 32;

/** Notified with the resolved directory just before it is enumerated, so the watcher can lazily start polling it. */
export type DirectoryListedListener = (sessionId: string, path: string) => void;

/** Lists directories under a Session's Project root, tolerating entries that vanish mid-listing. */
export class ListingService {
    private readonly listRequests = new SingleFlight<string, FileEntry[]>();
    private readonly browseRequests = new SingleFlight<
        string,
        RuntimeMethodResult<'files.browse'>
    >();

    constructor(
        private readonly resolveSessionPath: ResolveSessionPath,
        private readonly logger: StructuredLogger,
        private readonly fileTreeExcludes: () => FileTreeExcludes,
        private readonly onDirectoryListed?: DirectoryListedListener,
    ) {}

    list(sessionId: string, directory?: string): Promise<FileEntry[]> {
        const excludes = this.fileTreeExcludes();
        return this.listRequests.run(JSON.stringify([sessionId, directory ?? null, excludes]), () =>
            this.loadList(sessionId, directory, excludes),
        );
    }

    browse(
        params: RuntimeMethodParams<'files.browse'>,
    ): Promise<RuntimeMethodResult<'files.browse'>> {
        const excludes = this.fileTreeExcludes();
        return this.browseRequests.run(JSON.stringify([params, excludes]), () =>
            this.loadBrowse(params, excludes),
        );
    }

    private async loadList(
        sessionId: string,
        directory: string | undefined,
        excludes: FileTreeExcludes,
    ): Promise<FileEntry[]> {
        const startedAt = performance.now();
        const { root, path, names } = await this.loadVisibleNames(sessionId, directory, excludes);
        const sorted = this.sortEntries(await this.describeEntries(path, names));
        this.logger.write('info', 'file.list', {
            durationMs: performance.now() - startedAt,
            fields: { sessionId, path: relative(root, path) || '.', entryCount: sorted.length },
        });
        return sorted;
    }

    private async loadBrowse(
        { sessionId, directory, query }: RuntimeMethodParams<'files.browse'>,
        excludes: FileTreeExcludes,
    ): Promise<RuntimeMethodResult<'files.browse'>> {
        const startedAt = performance.now();
        const { root, path, names } = await this.loadVisibleNames(sessionId, directory, excludes);
        const normalizedQuery = query.toLocaleLowerCase();
        const matches = names
            .filter((name) => name.toLocaleLowerCase().includes(normalizedQuery))
            .sort((a, b) => a.localeCompare(b));
        const truncated = matches.length > MAX_FILE_BROWSE_ENTRIES;
        const entries = this.sortEntries(
            await this.describeEntries(path, matches.slice(0, MAX_FILE_BROWSE_ENTRIES)),
        );
        this.logger.write('info', 'file.browse', {
            durationMs: performance.now() - startedAt,
            fields: {
                sessionId,
                path: relative(root, path) || '.',
                entryCount: entries.length,
                truncated,
            },
        });
        return { entries, truncated };
    }

    private async loadVisibleNames(
        sessionId: string,
        directory: string | undefined,
        excludes: FileTreeExcludes,
    ): Promise<{ root: string; path: string; names: string[] }> {
        const { root, path } = await this.resolveSessionPath(sessionId, directory);
        this.onDirectoryListed?.(sessionId, path);
        const before = await lstat(path);
        if (!before.isDirectory() || before.isSymbolicLink())
            throw new CaxriError('IO', 'Path is not a directory');
        const entries = await readdir(path, { withFileTypes: true });
        const after = await lstat(path);
        /** Revalidate around readdir so a Session-root swap cannot disclose another directory. */
        if (
            !after.isDirectory() ||
            after.isSymbolicLink() ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            (await realpath(path)) !== path
        )
            throw new CaxriError('IO', 'Directory changed during listing');
        const names = entries
            .filter((entry) => {
                const relativePath = relative(root, resolve(path, entry.name)).split(sep).join('/');
                return !matchesFileTreeExclude(relativePath, excludes);
            })
            .map((entry) => entry.name);
        return { root, path, names };
    }

    private async describeEntries(
        directory: string,
        names: readonly string[],
    ): Promise<FileEntry[]> {
        const settled = await mapWithConcurrency(names, MAX_CONCURRENT_ENTRY_STATS, (name) =>
            this.describeEntry(directory, name),
        );
        return settled.filter((entry): entry is FileEntry => entry !== undefined);
    }

    private sortEntries(entries: FileEntry[]): FileEntry[] {
        return entries.sort((a, b) =>
            a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
        );
    }

    /**
     * Describes one directory entry, tolerating entries that vanish between `readdir` and `lstat`.
     * An AI agent or build tool can rewrite a directory rapidly enough that this is routine, not
     * exceptional, so a single missing entry must never fail the whole listing.
     */
    private async describeEntry(directory: string, name: string): Promise<FileEntry | undefined> {
        const entryPath = resolve(directory, name);
        let stats: Awaited<ReturnType<typeof lstat>>;
        try {
            stats = await lstat(entryPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                this.logger.write('debug', 'file.list_entry_skipped', {
                    fields: {
                        path: entryPath,
                        error: errorMessage(error, 'unknown'),
                    },
                });
            return undefined;
        }
        if (stats.isSymbolicLink()) return { name, path: entryPath, kind: 'symlink' };
        if (stats.isDirectory()) return { name, path: entryPath, kind: 'directory' };
        return { name, path: entryPath, kind: 'file', size: stats.size };
    }
}
