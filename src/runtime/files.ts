import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import parcelWatcher from '@parcel/watcher';

import type { RuntimeEvent } from '../shared/contracts';
import type { FileChange, FileDocument, FileEntry } from '../shared/types';
import type { CaxriDatabase } from './database';
import type { StructuredLogger } from './logger';
import { NATIVE_WATCHER_BACKEND } from './native-watcher';
import { isOutsideRoot } from './path-security';
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
const MAX_POLLED_DIRECTORIES = 64;
const MAX_RECENT_CHANGE_FINGERPRINTS = 5_000;
const WATCH_BATCH_DELAY_MS = 75;
const WATCH_POLL_INTERVAL_MS = 750;
const MISSING_PATH_FINGERPRINT = '<missing>';
const WATCHER_IGNORE_PATTERNS = [...IGNORED_SEGMENTS].flatMap((segment) => [
    `**/${segment}`,
    `**/${segment}/**`,
]);

function isIgnored(path: string): boolean {
    return path.split(sep).some((segment) => IGNORED_SEGMENTS.has(segment));
}

function fileSignature(stats: Awaited<ReturnType<typeof lstat>>): string {
    return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${stats.mode}:${stats.ino}`;
}

/** @internal Retains the active root while bounding fallback polling with LRU eviction. */
export function rememberPolledDirectory<T>(
    directories: Map<string, T>,
    directory: string,
    value: T,
    protectedRoot: string | undefined,
    maximum: number,
): void {
    directories.delete(directory);
    directories.set(directory, value);
    while (directories.size > Math.max(1, maximum)) {
        let candidate: string | undefined;
        for (const path of directories.keys()) {
            if (path === protectedRoot) continue;
            candidate = path;
            break;
        }
        if (!candidate) return;
        directories.delete(candidate);
    }
}

/** @internal Returns false when native and polling backends observed the same file version. */
export function rememberChangeFingerprint(
    fingerprints: Map<string, string>,
    path: string,
    fingerprint: string,
    maximum: number,
): boolean {
    if (fingerprints.get(path) === fingerprint) return false;
    fingerprints.delete(path);
    fingerprints.set(path, fingerprint);
    while (fingerprints.size > Math.max(1, maximum)) {
        const oldest = fingerprints.keys().next().value;
        if (!oldest) break;
        fingerprints.delete(oldest);
    }
    return true;
}

type OpenFile = (path: string, flags: number, mode?: number) => ReturnType<typeof open>;

interface FileServiceOptions {
    maxPolledDirectories?: number;
    openFile?: OpenFile;
}

export class FileService {
    private readonly listRequests = new SingleFlight<string, FileEntry[]>();
    private watcher?: parcelWatcher.AsyncSubscription;
    private watchedSessionId?: string;
    private watchGeneration = 0;
    private watchSetup?: Promise<void>;
    private pendingEvents = new Map<string, FileChange['kind']>();
    private droppedEvents = 0;
    private eventTimer?: NodeJS.Timeout;
    private pollTimer?: NodeJS.Timeout;
    private pollInFlight = false;
    private readonly polledDirectories = new Map<string, Map<string, string>>();
    private readonly recentChangeFingerprints = new Map<string, string>();
    private readonly maxPolledDirectories: number;
    private readonly openFile: OpenFile;
    private watchedRoot?: string;

    constructor(
        private readonly database: CaxriDatabase,
        private readonly emit: (event: RuntimeEvent) => void,
        private readonly logger: StructuredLogger,
        private readonly maxFileBytes: () => number,
        options: FileServiceOptions = {},
    ) {
        this.maxPolledDirectories = options.maxPolledDirectories ?? MAX_POLLED_DIRECTORIES;
        this.openFile = options.openFile ?? open;
    }

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
        if (isOutsideRoot(resolvedRelative))
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
        if (sessionId === this.watchedSessionId) {
            const existing = this.polledDirectories.get(path);
            if (existing) this.rememberPolledDirectory(path, existing);
            else void this.initializePolledDirectory(path, this.watchGeneration);
        }
        const before = await lstat(path);
        if (!before.isDirectory() || before.isSymbolicLink())
            throw new Error('Path is not a directory');
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
            throw new Error('Directory changed during listing');
        const visible = entries.filter(
            (entry) => !IGNORED_SEGMENTS.has(entry.name) && !entry.name.endsWith('.db-wal'),
        );
        const result = await Promise.all(
            visible.map(async (entry): Promise<FileEntry> => {
                const entryPath = resolve(path, entry.name);
                const stats = await lstat(entryPath);
                if (stats.isSymbolicLink())
                    return { name: entry.name, path: entryPath, kind: 'symlink' };
                if (stats.isDirectory())
                    return { name: entry.name, path: entryPath, kind: 'directory' };
                return { name: entry.name, path: entryPath, kind: 'file', size: stats.size };
            }),
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

    async read(sessionId: string, path: string): Promise<FileDocument> {
        const resolved = await this.resolveSessionPath(sessionId, path);
        const stats = await lstat(resolved.path);
        if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Path is not a file');
        const file = await this.openFile(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            if ((await realpath(resolved.path)) !== resolved.path)
                throw new Error('File path changed during read');
            const openedStats = await file.stat();
            if (
                !openedStats.isFile() ||
                openedStats.dev !== stats.dev ||
                openedStats.ino !== stats.ino ||
                openedStats.nlink > 1
            ) {
                throw new Error('File changed during read or has multiple filesystem links');
            }
            if (openedStats.size > this.maxFileBytes())
                throw new Error(`File exceeds the ${this.maxFileBytes()} byte safety limit`);
            const buffer = await file.readFile();
            if (buffer.subarray(0, 8_192).includes(0))
                throw new Error('Binary files cannot be opened in the editor');
            return {
                path: resolved.path,
                content: buffer.toString('utf8'),
                mtimeMs: openedStats.mtimeMs,
                size: openedStats.size,
            };
        } finally {
            await file.close();
        }
    }

    async write(sessionId: string, path: string, content: string): Promise<FileDocument> {
        const resolved = await this.resolveSessionPath(sessionId, path);
        const stats = await lstat(resolved.path);
        if (!stats.isFile() || stats.isSymbolicLink())
            throw new Error('Only existing regular files can be saved');
        if (Buffer.byteLength(content, 'utf8') > this.maxFileBytes())
            throw new Error('Edited file exceeds the write safety limit');
        const file = await this.openFile(resolved.path, constants.O_WRONLY | constants.O_NOFOLLOW);
        try {
            if ((await realpath(resolved.path)) !== resolved.path)
                throw new Error('File path changed during save');
            const openedStats = await file.stat();
            if (
                !openedStats.isFile() ||
                openedStats.dev !== stats.dev ||
                openedStats.ino !== stats.ino ||
                openedStats.nlink > 1
            ) {
                throw new Error('File changed during save or has multiple filesystem links');
            }
            await file.truncate(0);
            await file.writeFile(content, 'utf8');
        } finally {
            await file.close();
        }
        this.logger.write('info', 'file.saved', {
            fields: { sessionId, path: relative(resolved.root, resolved.path) },
        });
        return this.read(sessionId, resolved.path);
    }

    watchSession(sessionId?: string): Promise<void> {
        if (sessionId === this.watchedSessionId) return this.watchSetup ?? Promise.resolve();
        const generation = ++this.watchGeneration;
        this.watchedSessionId = sessionId;
        if (this.eventTimer) clearTimeout(this.eventTimer);
        this.eventTimer = undefined;
        this.pendingEvents.clear();
        this.droppedEvents = 0;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = undefined;
        this.polledDirectories.clear();
        this.recentChangeFingerprints.clear();
        this.watchedRoot = undefined;
        this.watchSetup = this.installWatcher(sessionId, generation);
        return this.watchSetup;
    }

    private installWatcher(sessionId: string | undefined, generation: number): Promise<void> {
        const setup = this.replaceWatcher(sessionId, generation)
            .catch((error: unknown) => {
                this.logger.write('warn', 'watcher.setup_failed', {
                    fields: {
                        sessionId: sessionId ?? 'none',
                        error: error instanceof Error ? error.message : 'unknown watcher error',
                    },
                });
            })
            .finally(() => {
                if (generation === this.watchGeneration && this.watchSetup === setup)
                    this.watchSetup = undefined;
            });
        this.watchSetup = setup;
        return setup;
    }

    private async replaceWatcher(sessionId: string | undefined, generation: number): Promise<void> {
        const startedAt = performance.now();
        const previousWatcher = this.watcher;
        this.watcher = undefined;
        await previousWatcher?.unsubscribe();
        if (generation !== this.watchGeneration) return;
        if (!sessionId) return;
        const { root } = await this.resolveSessionPath(sessionId);
        if (generation !== this.watchGeneration) return;
        this.watchedRoot = root;
        if (!this.polledDirectories.has(root)) {
            await this.initializePolledDirectory(root, generation);
        }
        if (generation !== this.watchGeneration) return;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = setInterval(
            () => void this.pollDirectories(sessionId, generation),
            WATCH_POLL_INTERVAL_MS,
        );
        this.pollTimer.unref();
        try {
            const watcher = await parcelWatcher.subscribe(
                root,
                (error, events) => {
                    if (generation !== this.watchGeneration) return;
                    if (error) {
                        this.activatePollingFallback(sessionId, generation, error);
                        return;
                    }
                    for (const event of events) {
                        const relativePath = relative(root, event.path);
                        if (isOutsideRoot(relativePath) || isIgnored(relativePath)) continue;
                        void this.queueNativeEvent(sessionId, event.type, event.path, generation);
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
            this.activatePollingFallback(sessionId, generation, error);
            this.logger.write('info', 'watcher.ready', {
                durationMs: performance.now() - startedAt,
                fields: { sessionId, backend: 'poll' },
            });
        }
    }

    private activatePollingFallback(sessionId: string, generation: number, error: unknown): void {
        if (generation !== this.watchGeneration) return;
        const watcher = this.watcher;
        this.watcher = undefined;
        void watcher?.unsubscribe();
        this.logger.write('warn', 'watcher.fallback', {
            fields: {
                sessionId,
                error: error instanceof Error ? error.message : 'unknown watcher error',
            },
        });
    }

    private async queueNativeEvent(
        sessionId: string,
        kind: FileChange['kind'],
        path: string,
        generation: number,
    ): Promise<void> {
        let fingerprint = MISSING_PATH_FINGERPRINT;
        try {
            fingerprint = fileSignature(await lstat(path));
        } catch {
            /** Missing paths share a stable fingerprint so native and polling delete events coalesce. */
        }
        if (generation !== this.watchGeneration) return;
        this.queueFingerprintedEvent(
            sessionId,
            fingerprint === MISSING_PATH_FINGERPRINT ? 'delete' : kind,
            path,
            fingerprint,
        );
    }

    private queueFingerprintedEvent(
        sessionId: string,
        kind: FileChange['kind'],
        path: string,
        fingerprint?: string,
    ): void {
        if (
            fingerprint !== undefined &&
            !rememberChangeFingerprint(
                this.recentChangeFingerprints,
                path,
                fingerprint,
                MAX_RECENT_CHANGE_FINGERPRINTS,
            )
        )
            return;
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

    private async readDirectorySignatures(directory: string): Promise<Map<string, string>> {
        const entries = await readdir(directory, { withFileTypes: true });
        const signatures = new Map<string, string>();
        await Promise.all(
            entries
                .filter(
                    (entry) => !IGNORED_SEGMENTS.has(entry.name) && !entry.name.endsWith('.db-wal'),
                )
                .map(async (entry) => {
                    const path = resolve(directory, entry.name);
                    const stats = await lstat(path);
                    signatures.set(path, fileSignature(stats));
                }),
        );
        return signatures;
    }

    private async initializePolledDirectory(directory: string, generation: number): Promise<void> {
        try {
            const signatures = await this.readDirectorySignatures(directory);
            if (generation === this.watchGeneration) {
                this.rememberPolledDirectory(directory, signatures);
            }
        } catch {
            if (generation === this.watchGeneration) this.polledDirectories.delete(directory);
        }
    }

    /** Poll only the root and directories the user expanded, bounding fallback work in large repositories. */
    private async pollDirectories(sessionId: string, generation: number): Promise<void> {
        if (this.pollInFlight || generation !== this.watchGeneration) return;
        this.pollInFlight = true;
        try {
            for (const [directory, previous] of this.polledDirectories) {
                let current: Map<string, string>;
                try {
                    current = await this.readDirectorySignatures(directory);
                } catch {
                    continue;
                }
                if (generation !== this.watchGeneration) return;
                for (const [path, signature] of current) {
                    if (previous.get(path) !== signature) {
                        this.queueFingerprintedEvent(
                            sessionId,
                            previous.has(path) ? 'update' : 'create',
                            path,
                            signature,
                        );
                    }
                }
                for (const path of previous.keys()) {
                    if (!current.has(path))
                        this.queueFingerprintedEvent(
                            sessionId,
                            'delete',
                            path,
                            MISSING_PATH_FINGERPRINT,
                        );
                }
                this.polledDirectories.set(directory, current);
            }
        } finally {
            this.pollInFlight = false;
        }
    }

    private rememberPolledDirectory(directory: string, signatures: Map<string, string>): void {
        rememberPolledDirectory(
            this.polledDirectories,
            directory,
            signatures,
            this.watchedRoot,
            this.maxPolledDirectories,
        );
    }

    async close(): Promise<void> {
        this.watchGeneration += 1;
        if (this.eventTimer) clearTimeout(this.eventTimer);
        if (this.pollTimer) clearInterval(this.pollTimer);
        const watcher = this.watcher;
        const setup = this.watchSetup;
        this.watcher = undefined;
        this.polledDirectories.clear();
        this.recentChangeFingerprints.clear();
        await Promise.allSettled([watcher?.unsubscribe(), setup]);
    }
}
