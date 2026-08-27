import { Buffer } from 'node:buffer';
import type { Dirent } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import type { FileEntry, ServerOperationParameters, ServerOperationResult } from '@caxri/protocol';
import {
    CaxriError,
    errorMessage,
    MAX_FILE_BROWSE_ENTRIES,
    MAX_FILE_LIST_ENTRIES,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import {
    AsyncSemaphore,
    logEventCatalog,
    mapWithConcurrency,
    waitForSharedOperation,
} from '@caxri/system';

import { SingleFlight } from '../single-flight';
import type { ResolveSessionPath } from './documents';
import type { FileTreeExcludes } from './file-tree-excludes';
import { isFileTreeExcludeMatch } from './file-tree-excludes';

const MAX_CONCURRENT_ENTRY_STATS = 32;
/**
 * Bounds a rare or absent path refinement independently of how many names match it.
 */
export const MAX_FILE_BROWSE_SCANNED_ENTRIES = 4_096;
/**
 * Prevents path browsing from exhausting Server directory handles across concurrent Sessions.
 */
export const MAX_CONCURRENT_FILE_BROWSES = 4;
/**
 * Leaves transport-envelope headroom below the historical controlled-view result ceiling.
 */
export const MAX_FILE_LIST_RESULT_BYTES = 3 * 1024 * 1024;
/**
 * Bounds Server memory and latency before the smaller sorted page and serialized byte limits are applied.
 */
const MAX_FILE_LIST_SCANNED_ENTRIES = 4_096;

export function boundFileListEntries(entries: readonly FileEntry[]): FileEntry[] {
    const bounded: FileEntry[] = [];
    let bytes = Buffer.byteLength('{"entries":[],"truncated":true}', 'utf8');
    for (const entry of entries) {
        const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
        if (bytes + entryBytes > MAX_FILE_LIST_RESULT_BYTES) break;
        bounded.push(entry);
        bytes += entryBytes;
    }
    return bounded;
}

/**
 * Notified with the resolved directory just before it is enumerated, so the watcher can lazily start polling it.
 */
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

/**
 * Lists directories under a Session's Project root, tolerating entries that vanish mid-listing.
 */
export class ListingService {
    private readonly listRequests = new SingleFlight<string, ServerOperationResult<'files.list'>>();
    private readonly browseRequests = new SingleFlight<
        string,
        ServerOperationResult<'files.browse'>
    >();
    private readonly browseConcurrency = new AsyncSemaphore(MAX_CONCURRENT_FILE_BROWSES);
    /**
     * One dialog owns browsing per Session, so navigation supersedes its previous directory too.
     */
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

    private async loadBrowse(
        { sessionId, directory, query }: ServerOperationParameters<'files.browse'>,
        excludes: FileTreeExcludes,
        isCurrent: () => boolean,
    ): Promise<ServerOperationResult<'files.browse'>> {
        const startedAt = performance.now();
        const { root, path } = await this.resolveSessionPath(sessionId, directory);
        if (!isCurrent()) return { entries: [], truncated: true };
        this.onDirectoryListed?.(sessionId, path);
        const before = await lstat(path);
        if (!before.isDirectory() || before.isSymbolicLink())
            throw new CaxriError('IO', 'Path is not a directory');
        const normalizedQuery = query.toLocaleLowerCase();
        const matches: FileEntry[] = [];
        let isReachedEnd = false;
        let scannedEntries = 0;
        const directoryHandle = await this.openDirectory(path);
        try {
            while (
                matches.length <= MAX_FILE_BROWSE_ENTRIES &&
                scannedEntries < MAX_FILE_BROWSE_SCANNED_ENTRIES
            ) {
                // `Dir#read()` streams one entry per call from a single open directory handle; the
                // reads are inherently sequential and cannot be parallelized.
                // eslint-disable-next-line no-await-in-loop -- see comment above
                const entry = await directoryHandle.read();
                if (!isCurrent()) return { entries: [], truncated: true };
                if (!entry) {
                    isReachedEnd = true;
                    break;
                }
                scannedEntries += 1;
                const relativePath = relative(root, resolve(path, entry.name)).split(sep).join('/');
                if (
                    !isFileTreeExcludeMatch(relativePath, excludes) &&
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
            try {
                await directoryHandle.close();
            } catch {
                // Ignore close failures: the directory handle is being discarded regardless.
            }
        }
        if (!isCurrent()) return { entries: [], truncated: true };
        const after = await lstat(path);
        /**
         * Revalidate around streaming enumeration so a Session-root swap cannot disclose names.
         */
        if (
            !after.isDirectory() ||
            after.isSymbolicLink() ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            (await realpath(path)) !== path
        )
            throw new CaxriError('IO', 'Directory changed during listing');
        const isTruncated = !isReachedEnd || matches.length > MAX_FILE_BROWSE_ENTRIES;
        /**
         * Dirent metadata stays bound to the opened directory instead of restatting a mutable path.
         */
        const entries = matches
            .toSorted((a, b) =>
                a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
            )
            .slice(0, MAX_FILE_BROWSE_ENTRIES);
        this.logger.write('info', logEventCatalog.file.browse, {
            durationMs: performance.now() - startedAt,
            fields: {
                sessionId,
                path: relative(root, path) || '.',
                entryCount: entries.length,
                scannedEntries,
                truncated: isTruncated,
            },
        });
        return { entries, truncated: isTruncated };
    }

    private async loadList(
        sessionId: string,
        directory: string | undefined,
        excludes: FileTreeExcludes,
    ): Promise<ServerOperationResult<'files.list'>> {
        const startedAt = performance.now();
        const { root, path } = await this.resolveSessionPath(sessionId, directory);
        this.onDirectoryListed?.(sessionId, path);
        const before = await lstat(path);
        if (!before.isDirectory() || before.isSymbolicLink())
            throw new CaxriError('IO', 'Path is not a directory');
        const entries: Dirent[] = [];
        let isReachedEnd = false;
        let scannedEntries = 0;
        const directoryHandle = await this.openDirectory(path);
        try {
            while (scannedEntries <= MAX_FILE_LIST_SCANNED_ENTRIES) {
                // `Dir#read()` streams one entry per call from a single open directory handle.
                // eslint-disable-next-line no-await-in-loop -- directory reads are inherently sequential
                const entry = await directoryHandle.read();
                if (!entry) {
                    isReachedEnd = true;
                    break;
                }
                scannedEntries += 1;
                if (entries.length < MAX_FILE_LIST_SCANNED_ENTRIES) entries.push(entry);
                else break;
            }
        } finally {
            try {
                await directoryHandle.close();
            } catch {
                // Ignore close failures: the directory handle is being discarded regardless.
            }
        }
        const after = await lstat(path);
        /**
         * Revalidate around streaming enumeration so a Session-root swap cannot disclose another directory.
         */
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
            return !isFileTreeExcludeMatch(relativePath, excludes);
        });
        const boundedVisible = visible
            .toSorted((a, b) =>
                a.isDirectory() === b.isDirectory()
                    ? a.name.localeCompare(b.name)
                    : a.isDirectory()
                      ? -1
                      : 1,
            )
            .slice(0, MAX_FILE_LIST_ENTRIES);
        const [settled, gitIgnoreDecoration] = await Promise.all([
            mapWithConcurrency(boundedVisible, MAX_CONCURRENT_ENTRY_STATS, (entry) =>
                this.describeEntry(path, entry.name),
            ),
            this.loadGitIgnoredNames(
                sessionId,
                path,
                boundedVisible.map((entry) => entry.name),
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
        const sorted = result.toSorted((a, b) =>
            a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
        );
        const bounded = boundFileListEntries(sorted);
        const isTruncated =
            !isReachedEnd ||
            visible.length > boundedVisible.length ||
            bounded.length < sorted.length;
        this.logger.write('info', logEventCatalog.file.list, {
            durationMs: performance.now() - startedAt,
            fields: {
                sessionId,
                path: relative(root, path) || '.',
                entryCount: bounded.length,
                scannedEntries,
                truncated: isTruncated,
            },
        });
        return { entries: bounded, truncated: isTruncated };
    }

    /**
     * Git decoration is optional metadata; an unavailable CLI or non-repository never blocks browsing.
     */
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
            this.logger.write('debug', logEventCatalog.file.gitIgnoreUnavailable, {
                fields: { directory, error: errorMessage(error, 'unknown') },
            });
            return { ignoredNames: new Set(), rulePaths: [] };
        }
    }

    /**
     * Describes one directory entry, tolerating entries that vanish between `readdir` and `lstat`. An AI agent or build
     * tool can rewrite a directory rapidly enough that this is routine, not exceptional, so a single missing entry must
     * never fail the whole listing.
     */
    private async describeEntry(directory: string, name: string): Promise<FileEntry | undefined> {
        const entryPath = resolve(directory, name);
        let stats: Awaited<ReturnType<typeof lstat>>;
        try {
            stats = await lstat(entryPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                this.logger.write('debug', logEventCatalog.file.listEntrySkipped, {
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

    listDirectory(
        sessionId: string,
        directory?: string,
        signal?: AbortSignal,
    ): Promise<ServerOperationResult<'files.list'>> {
        const excludes = this.fileTreeExcludes();
        const operation = this.listRequests.run(
            JSON.stringify([sessionId, directory ?? null, excludes]),
            () => this.loadList(sessionId, directory, excludes),
        );
        return waitForSharedOperation(
            operation,
            signal,
            () => new CaxriError('CANCELLED', 'Runtime request was canceled'),
        );
    }

    async list(sessionId: string, directory?: string, signal?: AbortSignal): Promise<FileEntry[]> {
        return (await this.listDirectory(sessionId, directory, signal)).entries;
    }

    browse(
        parameters: ServerOperationParameters<'files.browse'>,
    ): Promise<ServerOperationResult<'files.browse'>> {
        const excludes = this.fileTreeExcludes();
        return this.browseRequests.run(JSON.stringify([parameters, excludes]), async () => {
            const token = Symbol('file-browse');
            this.activeBrowseTokens.set(parameters.sessionId, token);
            try {
                return await this.browseConcurrency.run(() =>
                    this.loadBrowse(
                        parameters,
                        excludes,
                        () => this.activeBrowseTokens.get(parameters.sessionId) === token,
                    ),
                );
            } finally {
                if (this.activeBrowseTokens.get(parameters.sessionId) === token)
                    this.activeBrowseTokens.delete(parameters.sessionId);
            }
        });
    }
}
