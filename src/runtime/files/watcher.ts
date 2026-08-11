import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import parcelWatcher from '@parcel/watcher';

import { errorMessage } from '../../shared/ipc/errors';
import type { RuntimeEvent } from '../../shared/ipc/events';
import { mapWithConcurrency } from '../../shared/node/concurrency';
import type { StructuredLogger } from '../../shared/node/logger';
import type { FileChange } from '../../shared/types';
import { NATIVE_WATCHER_BACKEND } from '../native-watcher';
import { isOutsideRoot } from '../path-security';
import type { ResolveSessionPath } from './documents';
import {
    isTraversalExcludedName,
    isTraversalExcludedPath,
    WATCHER_EXCLUDE_PATTERNS,
} from './ignore-rules';

const MAX_PENDING_WATCH_EVENTS = 5_000;
const MAX_POLLED_DIRECTORIES = 64;
const MAX_RECENT_CHANGE_FINGERPRINTS = 5_000;
const WATCH_BATCH_DELAY_MS = 75;
const WATCH_POLL_INTERVAL_MS = 750;
const MISSING_PATH_FINGERPRINT = '<missing>';
const MAX_CONCURRENT_POLL_DIRECTORIES = 4;
const MAX_CONCURRENT_SIGNATURE_STATS = 16;

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

export interface WatcherServiceOptions {
    maxPolledDirectories?: number;
    pollIntervalMs?: number;
    subscribe?: typeof parcelWatcher.subscribe;
}

/**
 * Watches the selected Session's Project root for changes, with a signature-polling fallback when
 * the native watcher backend cannot be installed. Also owns the bounded, lazily-populated polled
 * directory signatures that `ListingService` primes via `noteDirectoryListed`.
 */
export class WatcherService {
    private watcher?: parcelWatcher.AsyncSubscription;
    private watchedSessionId?: string;
    private watchGeneration = 0;
    private watchSetup?: Promise<void>;
    private pendingEvents = new Map<string, FileChange['kind']>();
    private droppedEvents = 0;
    private eventTimer?: NodeJS.Timeout;
    private gitIgnoreRulePollTimer?: NodeJS.Timeout;
    private gitIgnoreRulePollInFlight = false;
    private gitIgnoreRulesChanged = false;
    private pollTimer?: NodeJS.Timeout;
    private pollInFlight = false;
    private pollingActive = false;
    private readonly listedDirectories = new Map<string, true>();
    private readonly gitIgnoreRuleFingerprints = new Map<string, string>();
    private readonly polledDirectories = new Map<string, Map<string, string>>();
    private readonly recentChangeFingerprints = new Map<string, string>();
    private readonly maxPolledDirectories: number;
    private readonly pollIntervalMs: number;
    private readonly subscribe: typeof parcelWatcher.subscribe;
    private watchedRoot?: string;

    constructor(
        private readonly resolveSessionPath: ResolveSessionPath,
        private readonly emit: (event: RuntimeEvent) => void,
        private readonly logger: StructuredLogger,
        options: WatcherServiceOptions = {},
    ) {
        this.maxPolledDirectories = options.maxPolledDirectories ?? MAX_POLLED_DIRECTORIES;
        this.pollIntervalMs = options.pollIntervalMs ?? WATCH_POLL_INTERVAL_MS;
        this.subscribe = options.subscribe ?? parcelWatcher.subscribe;
    }

    /** Primes fallback polling for a directory the moment it is listed, without waiting for the poll tick. */
    noteDirectoryListed(sessionId: string, path: string): void {
        if (sessionId !== this.watchedSessionId) return;
        if (this.watchedRoot) {
            const relativePath = relative(this.watchedRoot, path);
            if (isOutsideRoot(relativePath) || isTraversalExcludedPath(relativePath)) return;
        }
        rememberPolledDirectory(
            this.listedDirectories,
            path,
            true,
            this.watchedRoot,
            this.maxPolledDirectories,
        );
        if (!this.pollingActive) return;
        const existing = this.polledDirectories.get(path);
        if (existing) this.rememberPolledDirectory(path, existing);
        else void this.initializePolledDirectory(path, this.watchGeneration);
    }

    /** Polls only the explicit Git rule files resolved by Git, never the surrounding `.git` tree. */
    async noteGitIgnoreRulePaths(sessionId: string, paths: readonly string[]): Promise<void> {
        if (sessionId !== this.watchedSessionId) return;
        const generation = this.watchGeneration;
        const maximum = this.maxPolledDirectories * 3;
        const additions = [...new Set(paths)]
            .filter(
                (path) =>
                    isAbsolute(path) &&
                    !this.gitIgnoreRuleFingerprints.has(path) &&
                    this.gitIgnoreRuleFingerprints.size < maximum,
            )
            .slice(0, Math.max(0, maximum - this.gitIgnoreRuleFingerprints.size));
        const fingerprints = await mapWithConcurrency(
            additions,
            MAX_CONCURRENT_POLL_DIRECTORIES,
            async (path) => [path, await this.readPathFingerprint(path)] as const,
        );
        if (generation !== this.watchGeneration || sessionId !== this.watchedSessionId) return;
        for (const [path, fingerprint] of fingerprints)
            this.gitIgnoreRuleFingerprints.set(path, fingerprint);
        if (this.gitIgnoreRuleFingerprints.size === 0 || this.gitIgnoreRulePollTimer) return;
        this.gitIgnoreRulePollTimer = setInterval(
            () => void this.pollGitIgnoreRuleFiles(sessionId, generation),
            this.pollIntervalMs,
        );
        this.gitIgnoreRulePollTimer.unref();
    }

    watchSession(sessionId?: string): Promise<void> {
        if (sessionId === this.watchedSessionId) return this.watchSetup ?? Promise.resolve();
        const generation = ++this.watchGeneration;
        this.watchedSessionId = sessionId;
        if (this.eventTimer) clearTimeout(this.eventTimer);
        this.eventTimer = undefined;
        this.pendingEvents.clear();
        this.droppedEvents = 0;
        this.gitIgnoreRulesChanged = false;
        if (this.gitIgnoreRulePollTimer) clearInterval(this.gitIgnoreRulePollTimer);
        this.gitIgnoreRulePollTimer = undefined;
        this.gitIgnoreRulePollInFlight = false;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = undefined;
        this.pollingActive = false;
        this.listedDirectories.clear();
        this.gitIgnoreRuleFingerprints.clear();
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
                        error: errorMessage(error, 'unknown watcher error'),
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
        rememberPolledDirectory(
            this.listedDirectories,
            root,
            true,
            root,
            this.maxPolledDirectories,
        );
        try {
            const watcher = await this.subscribe(
                root,
                (error, events) => {
                    if (generation !== this.watchGeneration) return;
                    if (error) {
                        void this.activatePollingFallback(sessionId, generation, error);
                        return;
                    }
                    for (const event of events) {
                        const relativePath = relative(root, event.path);
                        if (isOutsideRoot(relativePath) || isTraversalExcludedPath(relativePath))
                            continue;
                        void this.queueNativeEvent(sessionId, event.type, event.path, generation);
                    }
                },
                { backend: NATIVE_WATCHER_BACKEND, ignore: WATCHER_EXCLUDE_PATTERNS },
            );
            if (generation !== this.watchGeneration) {
                await watcher.unsubscribe();
                return;
            }
            if (this.pollingActive) {
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
            await this.activatePollingFallback(sessionId, generation, error);
            this.logger.write('info', 'watcher.ready', {
                durationMs: performance.now() - startedAt,
                fields: { sessionId, backend: 'poll' },
            });
        }
    }

    private async activatePollingFallback(
        sessionId: string,
        generation: number,
        error: unknown,
    ): Promise<void> {
        if (generation !== this.watchGeneration) return;
        const watcher = this.watcher;
        this.watcher = undefined;
        void watcher?.unsubscribe();
        if (!this.pollingActive) {
            this.pollingActive = true;
            await mapWithConcurrency(
                [...this.listedDirectories.keys()],
                MAX_CONCURRENT_POLL_DIRECTORIES,
                (directory) => this.initializePolledDirectory(directory, generation),
            );
            if (generation !== this.watchGeneration) return;
            this.pollTimer = setInterval(
                () => void this.pollDirectories(sessionId, generation),
                this.pollIntervalMs,
            );
            this.pollTimer.unref();
        }
        this.logger.write('warn', 'watcher.fallback', {
            fields: {
                sessionId,
                error: errorMessage(error, 'unknown watcher error'),
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
        this.scheduleEventBatch(sessionId);
    }

    private queueGitIgnoreRuleChange(sessionId: string): void {
        this.gitIgnoreRulesChanged = true;
        this.scheduleEventBatch(sessionId);
    }

    private scheduleEventBatch(sessionId: string): void {
        this.eventTimer ??= setTimeout(() => {
            const changes = [...this.pendingEvents].map(([eventPath, eventKind]) => ({
                path: eventPath,
                kind: eventKind,
            }));
            this.emit({
                event: 'files.changed',
                payload: {
                    sessionId,
                    changes,
                    overflow: this.droppedEvents > 0,
                    ...(this.gitIgnoreRulesChanged ? { gitIgnoreRulesChanged: true as const } : {}),
                },
            });
            this.logger.write(this.droppedEvents > 0 ? 'warn' : 'debug', 'watcher.batch', {
                fields: {
                    sessionId,
                    count: this.pendingEvents.size,
                    droppedEvents: this.droppedEvents,
                    gitIgnoreRulesChanged: this.gitIgnoreRulesChanged,
                },
            });
            this.pendingEvents.clear();
            this.droppedEvents = 0;
            this.gitIgnoreRulesChanged = false;
            this.eventTimer = undefined;
        }, WATCH_BATCH_DELAY_MS);
    }

    private async readPathFingerprint(path: string): Promise<string> {
        try {
            return fileSignature(await lstat(path));
        } catch {
            return MISSING_PATH_FINGERPRINT;
        }
    }

    private async pollGitIgnoreRuleFiles(sessionId: string, generation: number): Promise<void> {
        if (this.gitIgnoreRulePollInFlight || generation !== this.watchGeneration) return;
        this.gitIgnoreRulePollInFlight = true;
        try {
            const fingerprints = await mapWithConcurrency(
                [...this.gitIgnoreRuleFingerprints],
                MAX_CONCURRENT_POLL_DIRECTORIES,
                async ([path, previous]) => ({
                    current: await this.readPathFingerprint(path),
                    path,
                    previous,
                }),
            );
            if (generation !== this.watchGeneration) return;
            let changed = false;
            for (const fingerprint of fingerprints) {
                if (fingerprint.current === fingerprint.previous) continue;
                this.gitIgnoreRuleFingerprints.set(fingerprint.path, fingerprint.current);
                changed = true;
            }
            if (changed) this.queueGitIgnoreRuleChange(sessionId);
        } finally {
            if (generation === this.watchGeneration) this.gitIgnoreRulePollInFlight = false;
        }
    }

    /**
     * Reads directory-entry signatures for the polling fallback, tolerating entries that vanish
     * between `readdir` and `lstat` the same way `ListingService` does: a single missing or
     * unreadable entry is skipped rather than failing the whole signature scan.
     */
    private async readDirectorySignatures(directory: string): Promise<Map<string, string>> {
        const entries = await readdir(directory, { withFileTypes: true });
        const signatures = new Map<string, string>();
        await mapWithConcurrency(
            entries.filter((entry) => !isTraversalExcludedName(entry.name)),
            MAX_CONCURRENT_SIGNATURE_STATS,
            async (entry) => {
                const path = resolve(directory, entry.name);
                try {
                    signatures.set(path, fileSignature(await lstat(path)));
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                        this.logger.write('debug', 'watcher.signature_entry_skipped', {
                            fields: {
                                path,
                                error: errorMessage(error, 'unknown'),
                            },
                        });
                }
            },
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
            await mapWithConcurrency(
                [...this.polledDirectories],
                MAX_CONCURRENT_POLL_DIRECTORIES,
                async ([directory, previous]) => {
                    let current: Map<string, string>;
                    try {
                        current = await this.readDirectorySignatures(directory);
                    } catch {
                        return;
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
                },
            );
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
        this.pollingActive = false;
        if (this.eventTimer) clearTimeout(this.eventTimer);
        if (this.gitIgnoreRulePollTimer) clearInterval(this.gitIgnoreRulePollTimer);
        if (this.pollTimer) clearInterval(this.pollTimer);
        const watcher = this.watcher;
        const setup = this.watchSetup;
        this.watcher = undefined;
        this.listedDirectories.clear();
        this.gitIgnoreRuleFingerprints.clear();
        this.polledDirectories.clear();
        this.recentChangeFingerprints.clear();
        await Promise.allSettled([watcher?.unsubscribe(), setup]);
    }
}
