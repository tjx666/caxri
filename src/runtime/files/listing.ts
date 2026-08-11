import { lstat, opendir, readdir, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { CaxriError, errorMessage } from '../../shared/ipc/errors';
import {
    MAX_FILE_BROWSE_ENTRIES,
    type RuntimeMethodParams,
    type RuntimeMethodResult,
} from '../../shared/ipc/methods';
import { AsyncSemaphore, mapWithConcurrency } from '../../shared/node/concurrency';
import type { StructuredLogger } from '../../shared/node/logger';
import type { FileEntry } from '../../shared/types';
import { SingleFlight } from '../single-flight';
import type { ResolveSessionPath } from './documents';
import { matchesFileTreeExclude, type FileTreeExcludes } from './file-tree-excludes';

const MAX_CONCURRENT_ENTRY_STATS = 32;
/** Bounds a rare or absent path refinement independently of how many names match it. */
export const MAX_FILE_BROWSE_SCANNED_ENTRIES = 4_096;
/** Prevents path browsing from exhausting Runtime directory handles across concurrent Sessions. */
export const MAX_CONCURRENT_FILE_BROWSES = 4;

/** Notified with the resolved directory just before it is enumerated, so the watcher can lazily start polling it. */
export type DirectoryListedListener = (sessionId: string, path: string) => void;
export type OpenDirectory = (path: string) => ReturnType<typeof opendir>;
export interface GitIgnoreDecoration {
    ignoredNames: ReadonlySet<string>;
    rulePaths: readonly string[];
}
export type GitIgnoreDecorator = (
    sessionId: string,
    directory: string,
    names: readonly string[],
) => Promise<GitIgnoreDecoration>;
export type GitIgnoreRulesListedListener = (
    sessionId: string,
    paths: readonly string[],
) => Promise<void>;

/** Lists directories under a Session's Project root, tolerating entries that vanish mid-listing. */
export class ListingService {
    private readonly listRequests = new SingleFlight<string, FileEntry[]>();
    private readonly browseRequests = new SingleFlight<
        string,
        RuntimeMethodResult<'files.browse'>
    >();
    private readonly browseConcurrency = new AsyncSemaphore(MAX_CONCURRENT_FILE_BROWSES);
    /** One dialog owns browsing per Session, so navigation supersedes its previous directory too. */
    private readonly activeBrowseTokens = new Map<string, symbol>();

    constructor(
        private readonly resolveSessionPath: ResolveSessionPath,
        private readonly logger: StructuredLogger,
        private readonly fileTreeExcludes: () => FileTreeExcludes,
        private readonly onDirectoryListed?: DirectoryListedListener,
        private readonly decorateGitIgnored?: GitIgnoreDecorator,
        private readonly onGitIgnoreRulesListed?: GitIgnoreRulesListedListener,
        private readonly openDirectory: OpenDirectory = opendir,
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
        return this.browseRequests.run(JSON.stringify([params, excludes]), async () => {
            const token = Symbol('file-browse');
            this.activeBrowseTokens.set(params.sessionId, token);
            try {
                return await this.browseConcurrency.run(() =>
                    this.loadBrowse(
                        params,
                        excludes,
                        () => this.activeBrowseTokens.get(params.sessionId) === token,
                    ),
                );
            } finally {
                if (this.activeBrowseTokens.get(params.sessionId) === token)
                    this.activeBrowseTokens.delete(params.sessionId);
            }
        });
    }

    private async loadBrowse(
        { sessionId, directory, query }: RuntimeMethodParams<'files.browse'>,
        excludes: FileTreeExcludes,
        isCurrent: () => boolean,
    ): Promise<RuntimeMethodResult<'files.browse'>> {
        const startedAt = performance.now();
        const { root, path } = await this.resolveSessionPath(sessionId, directory);
        if (!isCurrent()) return { entries: [], truncated: true };
        this.onDirectoryListed?.(sessionId, path);
        const before = await lstat(path);
        if (!before.isDirectory() || before.isSymbolicLink())
            throw new CaxriError('IO', 'Path is not a directory');
        const normalizedQuery = query.toLocaleLowerCase();
        const matches: FileEntry[] = [];
        let reachedEnd = false;
        let scannedEntries = 0;
        const directoryHandle = await this.openDirectory(path);
        try {
            while (
                matches.length <= MAX_FILE_BROWSE_ENTRIES &&
                scannedEntries < MAX_FILE_BROWSE_SCANNED_ENTRIES
            ) {
                const entry = await directoryHandle.read();
                if (!isCurrent()) return { entries: [], truncated: true };
                if (!entry) {
                    reachedEnd = true;
                    break;
                }
                scannedEntries += 1;
                const relativePath = relative(root, resolve(path, entry.name)).split(sep).join('/');
                if (
                    !matchesFileTreeExclude(relativePath, excludes) &&
                    entry.name.toLocaleLowerCase().includes(normalizedQuery)
                )
                    matches.push({
                        name: entry.name,
                        path: resolve(path, entry.name),
                        kind: entry.isSymbolicLink()
                            ? 'symlink'
                            : entry.isDirectory()
                              ? 'directory'
                              : 'file',
                    });
            }
        } finally {
            await directoryHandle.close().catch(() => undefined);
        }
        if (!isCurrent()) return { entries: [], truncated: true };
        const after = await lstat(path);
        /** Revalidate around streaming enumeration so a Session-root swap cannot disclose names. */
        if (
            !after.isDirectory() ||
            after.isSymbolicLink() ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            (await realpath(path)) !== path
        )
            throw new CaxriError('IO', 'Directory changed during listing');
        const truncated = !reachedEnd || matches.length > MAX_FILE_BROWSE_ENTRIES;
        /** Dirent metadata stays bound to the opened directory instead of restatting a mutable path. */
        const entries = matches
            .sort((a, b) =>
                a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
            )
            .slice(0, MAX_FILE_BROWSE_ENTRIES);
        this.logger.write('info', 'file.browse', {
            durationMs: performance.now() - startedAt,
            fields: {
                sessionId,
                path: relative(root, path) || '.',
                entryCount: entries.length,
                scannedEntries,
                truncated,
            },
        });
        return { entries, truncated };
    }

    private async loadList(
        sessionId: string,
        directory: string | undefined,
        excludes: FileTreeExcludes,
    ): Promise<FileEntry[]> {
        const startedAt = performance.now();
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
        const visible = entries.filter((entry) => {
            const relativePath = relative(root, resolve(path, entry.name)).split(sep).join('/');
            return !matchesFileTreeExclude(relativePath, excludes);
        });
        const [settled, gitIgnoreDecoration] = await Promise.all([
            mapWithConcurrency(visible, MAX_CONCURRENT_ENTRY_STATS, (entry) =>
                this.describeEntry(path, entry.name),
            ),
            this.loadGitIgnoredNames(
                sessionId,
                path,
                visible.map((entry) => entry.name),
            ),
        ]);
        await this.onGitIgnoreRulesListed?.(sessionId, gitIgnoreDecoration.rulePaths);
        const result = settled
            .filter((entry): entry is FileEntry => entry !== undefined)
            .map((entry) =>
                gitIgnoreDecoration.ignoredNames.has(entry.name)
                    ? { ...entry, gitIgnored: true as const }
                    : entry,
            );
        const sorted = result.sort((a, b) =>
            a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
        );
        this.logger.write('info', 'file.list', {
            durationMs: performance.now() - startedAt,
            fields: { sessionId, path: relative(root, path) || '.', entryCount: sorted.length },
        });
        return sorted;
    }

    /** Git decoration is optional metadata; an unavailable CLI or non-repository never blocks browsing. */
    private async loadGitIgnoredNames(
        sessionId: string,
        directory: string,
        names: readonly string[],
    ): Promise<GitIgnoreDecoration> {
        if (!this.decorateGitIgnored || names.length === 0)
            return { ignoredNames: new Set(), rulePaths: [] };
        try {
            return await this.decorateGitIgnored(sessionId, directory, names);
        } catch (error) {
            this.logger.write('debug', 'file.git_ignore_unavailable', {
                fields: { directory, error: errorMessage(error, 'unknown') },
            });
            return { ignoredNames: new Set(), rulePaths: [] };
        }
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
