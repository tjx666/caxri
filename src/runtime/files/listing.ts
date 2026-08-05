import { lstat, readdir, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { CaxriError } from '../../shared/ipc/errors';
import { mapWithConcurrency } from '../../shared/node/concurrency';
import type { StructuredLogger } from '../../shared/node/logger';
import type { FileEntry } from '../../shared/types';
import { SingleFlight } from '../single-flight';
import type { ResolveSessionPath } from './documents';
import { isIgnoredName } from './ignore-rules';

const MAX_CONCURRENT_ENTRY_STATS = 32;

/** Notified with the resolved directory just before it is enumerated, so the watcher can lazily start polling it. */
export type DirectoryListedListener = (sessionId: string, path: string) => void;

/** Lists directories under a Session's Project root, tolerating entries that vanish mid-listing. */
export class ListingService {
    private readonly listRequests = new SingleFlight<string, FileEntry[]>();

    constructor(
        private readonly resolveSessionPath: ResolveSessionPath,
        private readonly logger: StructuredLogger,
        private readonly onDirectoryListed?: DirectoryListedListener,
    ) {}

    list(sessionId: string, directory?: string): Promise<FileEntry[]> {
        return this.listRequests.run(JSON.stringify([sessionId, directory ?? null]), () =>
            this.loadList(sessionId, directory),
        );
    }

    private async loadList(sessionId: string, directory?: string): Promise<FileEntry[]> {
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
        const visible = entries.filter((entry) => !isIgnoredName(entry.name));
        const settled = await mapWithConcurrency(visible, MAX_CONCURRENT_ENTRY_STATS, (entry) =>
            this.describeEntry(path, entry.name),
        );
        const result = settled.filter((entry): entry is FileEntry => entry !== undefined);
        const sorted = result.sort((a, b) =>
            a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
        );
        this.logger.write('info', 'file.list', {
            durationMs: performance.now() - startedAt,
            fields: { sessionId, path: relative(root, path) || '.', entryCount: sorted.length },
        });
        return sorted;
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
                        error: error instanceof Error ? error.message : 'unknown',
                    },
                });
            return undefined;
        }
        if (stats.isSymbolicLink()) return { name, path: entryPath, kind: 'symlink' };
        if (stats.isDirectory()) return { name, path: entryPath, kind: 'directory' };
        return { name, path: entryPath, kind: 'file', size: stats.size };
    }
}
