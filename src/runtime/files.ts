import { lstat, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import parcelWatcher from '@parcel/watcher';

import type { RuntimeEvent } from '../shared/contracts';
import type { FileChange, FileDocument, FileEntry } from '../shared/types';
import type { CaxriDatabase } from './database';
import type { StructuredLogger } from './logger';
import { NATIVE_WATCHER_BACKEND } from './native-watcher';
import { SingleFlight } from './single-flight';

const IGNORED_SEGMENTS = new Set([
    '.git',
    '.hg',
    '.svn',
    'node_modules',
    '.next',
    '.nuxt',
    '.turbo',
    '.cache',
    'coverage',
    'dist',
    'build',
    'out',
    'target',
]);
const MAX_PENDING_WATCH_EVENTS = 5_000;
const WATCH_BATCH_DELAY_MS = 75;
const WATCHER_IGNORE_PATTERNS = [...IGNORED_SEGMENTS].flatMap((segment) => [
    `**/${segment}`,
    `**/${segment}/**`,
]);

function isIgnored(path: string): boolean {
    return path.split(sep).some((segment) => IGNORED_SEGMENTS.has(segment));
}

export class FileService {
    private readonly listRequests = new SingleFlight<string, FileEntry[]>();
    private watcher?: parcelWatcher.AsyncSubscription;
    private watchedSessionId?: string;
    private watchGeneration = 0;
    private watchSetup?: Promise<void>;
    private watcherRestartCount = 0;
    private restartTimer?: NodeJS.Timeout;
    private pendingEvents = new Map<string, FileChange['kind']>();
    private droppedEvents = 0;
    private eventTimer?: NodeJS.Timeout;

    constructor(
        private readonly database: CaxriDatabase,
        private readonly emit: (event: RuntimeEvent) => void,
        private readonly logger: StructuredLogger,
        private readonly maxFileBytes: () => number,
    ) {}

    async resolveSessionPath(
        sessionId: string,
        input?: string,
    ): Promise<{ root: string; path: string }> {
        const session = this.database.getSession(sessionId);
        if (!session) throw new Error('Session not found');
        const root = await realpath(session.rootPath);
        const candidate = input && isAbsolute(input) ? input : resolve(root, input ?? '.');
        const resolved = await realpath(candidate);
        const resolvedRelative = relative(root, resolved);
        if (resolvedRelative.startsWith('..') || isAbsolute(resolvedRelative))
            throw new Error('Symlink target is outside the Session root');
        return { root, path: resolved };
    }

    list(sessionId: string, directory?: string): Promise<FileEntry[]> {
        return this.listRequests.run(JSON.stringify([sessionId, directory ?? null]), () =>
            this.loadList(sessionId, directory),
        );
    }

    private async loadList(sessionId: string, directory?: string): Promise<FileEntry[]> {
        const startedAt = performance.now();
        const { root, path } = await this.resolveSessionPath(sessionId, directory);
        const entries = await readdir(path, { withFileTypes: true });
        const visible = entries.filter(
            (entry) => !IGNORED_SEGMENTS.has(entry.name) && !entry.name.endsWith('.db-wal'),
        );
        const result = await Promise.all(
            visible.map(async (entry): Promise<FileEntry> => {
                const entryPath = resolve(path, entry.name);
                if (entry.isSymbolicLink())
                    return { name: entry.name, path: entryPath, kind: 'symlink' };
                if (entry.isDirectory())
                    return { name: entry.name, path: entryPath, kind: 'directory' };
                const stats = await stat(entryPath);
                return { name: entry.name, path: entryPath, kind: 'file', size: stats.size };
            }),
        );
        const sorted = result.sort((a, b) =>
            a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
        );
        this.logger.write('debug', 'file.list', {
            durationMs: performance.now() - startedAt,
            fields: { sessionId, path: relative(root, path) || '.', entryCount: sorted.length },
        });
        return sorted;
    }

    async read(sessionId: string, path: string): Promise<FileDocument> {
        const resolved = await this.resolveSessionPath(sessionId, path);
        const stats = await stat(resolved.path);
        if (!stats.isFile()) throw new Error('Path is not a file');
        if (stats.size > this.maxFileBytes())
            throw new Error(`File exceeds the ${this.maxFileBytes()} byte safety limit`);
        const buffer = await readFile(resolved.path);
        if (buffer.subarray(0, 8_192).includes(0))
            throw new Error('Binary files cannot be opened in the editor');
        return {
            path: resolved.path,
            content: buffer.toString('utf8'),
            mtimeMs: stats.mtimeMs,
            size: stats.size,
        };
    }

    async write(sessionId: string, path: string, content: string): Promise<FileDocument> {
        const resolved = await this.resolveSessionPath(sessionId, path);
        const stats = await lstat(resolved.path);
        if (!stats.isFile() || stats.isSymbolicLink())
            throw new Error('Only existing regular files can be saved');
        if (Buffer.byteLength(content, 'utf8') > this.maxFileBytes() * 2)
            throw new Error('Edited file exceeds the write safety limit');
        await writeFile(resolved.path, content, 'utf8');
        this.logger.write('info', 'file.saved', {
            fields: { sessionId, path: relative(resolved.root, resolved.path) },
        });
        return this.read(sessionId, resolved.path);
    }

    watchSession(sessionId?: string): Promise<void> {
        if (sessionId === this.watchedSessionId) return this.watchSetup ?? Promise.resolve();
        const generation = ++this.watchGeneration;
        this.watchedSessionId = sessionId;
        this.watcherRestartCount = 0;
        this.watchSetup = this.installWatcher(sessionId, generation);
        return this.watchSetup;
    }

    private installWatcher(sessionId: string | undefined, generation: number): Promise<void> {
        const setup = this.replaceWatcher(sessionId, generation)
            .catch((error: unknown) => this.handleWatcherError(sessionId, generation, error))
            .finally(() => {
                if (generation === this.watchGeneration && this.watchSetup === setup)
                    this.watchSetup = undefined;
            });
        this.watchSetup = setup;
        return setup;
    }

    private async replaceWatcher(sessionId: string | undefined, generation: number): Promise<void> {
        const startedAt = performance.now();
        if (this.eventTimer) clearTimeout(this.eventTimer);
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.eventTimer = undefined;
        this.restartTimer = undefined;
        this.pendingEvents.clear();
        this.droppedEvents = 0;
        const previousWatcher = this.watcher;
        this.watcher = undefined;
        await previousWatcher?.unsubscribe();
        if (generation !== this.watchGeneration) return;
        if (!sessionId) return;
        const { root } = await this.resolveSessionPath(sessionId);
        try {
            const watcher = await parcelWatcher.subscribe(
                root,
                (error, events) => {
                    if (generation !== this.watchGeneration) return;
                    if (error) {
                        this.handleWatcherError(sessionId, generation, error);
                        return;
                    }
                    for (const event of events) {
                        const relativePath = relative(root, event.path);
                        if (
                            relativePath.startsWith('..') ||
                            isAbsolute(relativePath) ||
                            isIgnored(relativePath)
                        )
                            continue;
                        this.queueEvent(sessionId, event.type, event.path);
                    }
                },
                { backend: NATIVE_WATCHER_BACKEND, ignore: WATCHER_IGNORE_PATTERNS },
            );
            if (generation !== this.watchGeneration) {
                await watcher.unsubscribe();
                return;
            }
            this.watcher = watcher;
            this.logger.write('info', 'watcher.ready', {
                durationMs: performance.now() - startedAt,
                fields: { sessionId, backend: NATIVE_WATCHER_BACKEND },
            });
        } catch (error) {
            if (generation !== this.watchGeneration) return;
            this.handleWatcherError(sessionId, generation, error);
        }
    }

    private handleWatcherError(
        sessionId: string | undefined,
        generation: number,
        error: unknown,
    ): void {
        if (generation !== this.watchGeneration || this.restartTimer) return;
        this.logger.write('warn', 'watcher.error', {
            fields: {
                sessionId: sessionId ?? 'none',
                error: error instanceof Error ? error.message : 'unknown watcher error',
            },
        });
        if (!sessionId || this.watcherRestartCount >= 2) return;
        this.watcherRestartCount += 1;
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            if (generation !== this.watchGeneration || this.watchedSessionId !== sessionId) return;
            void this.installWatcher(sessionId, generation);
        }, 800);
    }

    private queueEvent(sessionId: string, kind: FileChange['kind'], path: string): void {
        if (this.pendingEvents.has(path) || this.pendingEvents.size < MAX_PENDING_WATCH_EVENTS) {
            this.pendingEvents.set(path, kind);
        } else {
            this.droppedEvents += 1;
        }
        this.eventTimer ??= setTimeout(() => {
            const changes = [...this.pendingEvents].map(([eventPath, eventKind]) => ({
                path: eventPath,
                kind: eventKind,
            }));
            this.emit({
                event: 'files.changed',
                payload: { sessionId, changes, overflow: this.droppedEvents > 0 },
            });
            this.logger.write(this.droppedEvents > 0 ? 'warn' : 'debug', 'watcher.batch', {
                fields: {
                    sessionId,
                    count: this.pendingEvents.size,
                    droppedEvents: this.droppedEvents,
                },
            });
            this.pendingEvents.clear();
            this.droppedEvents = 0;
            this.eventTimer = undefined;
        }, WATCH_BATCH_DELAY_MS);
    }

    async close(): Promise<void> {
        this.watchGeneration += 1;
        if (this.eventTimer) clearTimeout(this.eventTimer);
        if (this.restartTimer) clearTimeout(this.restartTimer);
        const watcher = this.watcher;
        const setup = this.watchSetup;
        this.watcher = undefined;
        await Promise.allSettled([watcher?.unsubscribe(), setup]);
    }
}
