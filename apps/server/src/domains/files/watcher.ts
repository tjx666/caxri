import { lstat, readdir } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';

import type { FileChange, ServerEvent } from '@caxri/protocol';
import { errorMessage, MAX_FILE_CHANGES_PER_EVENT } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, mapWithConcurrency } from '@caxri/system';
import type parcelWatcher from '@parcel/watcher';

import { NATIVE_WATCHER_BACKEND } from '../native-watcher';
import { isOutsideRoot } from '../path-security';
import type { ResolvedSessionPath } from '../project-roots';
import type { WatchHandle } from '../watch-hub';
import { WatchHub } from '../watch-hub';
import type { ResolveSessionPath } from './documents';
import { ExternalLinkWatcher } from './external-link-watcher';
import {
    isTraversalExcludedName,
    isTraversalExcludedPath,
    WATCHER_EXCLUDE_PATTERNS,
} from './ignore-rules';

const MAX_PENDING_WATCH_EVENTS = MAX_FILE_CHANGES_PER_EVENT;
const MAX_POLLED_DIRECTORIES = 64;
const MAX_RECENT_CHANGE_FINGERPRINTS = 5_000;
const WATCH_BATCH_DELAY_MS = 75;
const WATCH_POLL_INTERVAL_MS = 750;
const MISSING = '<missing>';
const MAX_CONCURRENT_POLL_DIRECTORIES = 4;
const MAX_CONCURRENT_SIGNATURE_STATS = 16;

/**
 * Git reports repository metadata rule paths such as `.git/info/exclude`, but it does not enumerate the distributed
 * `.gitignore` files in the working tree. Recognize those files directly from the authorized Project watcher so a rule
 * edit invalidates decorations for every affected visible directory instead of looking like an ordinary local write.
 */
function isWorkingTreeGitIgnore(path: string): boolean {
    return basename(path) === '.gitignore';
}

function fileSignature(stats: Awaited<ReturnType<typeof lstat>>): string {
    return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${stats.mode}:${stats.ino}`;
}

/**
 * Finds the oldest evictable key (Map iteration order's first key other than `protectedRoot`). Kept as its own function
 * (rather than nested inside `rememberPolledDirectory`'s `while` loop) so its `continue`/`break` control flow stays
 * scoped to a single loop.
 */
function oldestEvictableKey<T>(
    directories: ReadonlyMap<string, T>,
    protectedRoot: string | undefined,
): string | undefined {
    for (const path of directories.keys()) {
        if (path === protectedRoot) continue;
        return path;
    }
    return undefined;
}

/**
 * @internal
 */
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
        const candidate = oldestEvictableKey(directories, protectedRoot);
        if (!candidate) return;
        directories.delete(candidate);
    }
}

/**
 * @internal
 */
export function didFingerprintChange(
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
    resolveWorkspacePath?: ResolveSessionPath;
    maxPolledDirectories?: number;
    onRootUnavailable?: (sessionId: string) => void;
    pollIntervalMs?: number;
    /**
     * Test seam forwarded into the private watch hub when no shared hub is provided.
     */
    subscribe?: typeof parcelWatcher.subscribe;
    /**
     * Shared Server watch registry. Production passes the Server-wide hub; tests may omit it, in which case the service
     * owns a private hub with equivalent behavior.
     */
    watchHub?: WatchHub;
}

/**
 * Immutable source captured for each coalesced watcher batch.
 */
export interface WatchScope {
    sessionId: string;
    workbenchProjectId: string;
}

/**
 * Watches the selected Session's Project root for changes, with a signature-polling fallback when the native watcher
 * backend cannot be installed. Also owns the bounded, lazily-populated polled directory signatures that
 * `ListingService` primes via `noteDirectoryListed`.
 */
export class WatcherService {
    private readonly externalLinks: ExternalLinkWatcher;
    private watchHandle?: WatchHandle;
    private watchedScope?: WatchScope;
    private watchGeneration = 0;
    private watchSetup?: Promise<void>;
    private pendingScope?: WatchScope;
    private pendingEvents = new Map<string, FileChange['kind']>();
    private droppedEvents = 0;
    /**
     * Forces the next flushed batch to report `overflow: true` even though no individual change was queued for it. Set
     * by `triggerRescan` in response to a native "must rescan" advisory: the advisory means some events may have been
     * coalesced away, but (unlike the polling fallback's `pollDirectories`) there is no maintained signature baseline
     * to diff against while native, so a targeted create/update/delete list cannot be reconstructed. `overflow` is the
     * signal every Files consumer already treats as "refetch this scope regardless of the change list" (see
     * `isDirectoryAffected` in `apps/desktop/src/renderer/src/queries/invalidation.ts`), so reusing it here is the
     * smallest correct stand-in for a real rescan.
     */
    private forceRescanOverflow = false;
    private eventTimer?: NodeJS.Timeout;
    private ruleWatchHandle?: WatchHandle;
    private gitIgnoreRulePollInFlight = false;
    private gitIgnoreRulesChanged = false;
    private pollInFlight = false;
    private pollingActive = false;
    private readonly listedDirectories = new Map<string, true>();
    private readonly gitIgnoreRuleFingerprints = new Map<string, string>();
    private readonly externalRulePaths = new Set<string>();
    private readonly polledDirectories = new Map<string, Map<string, string>>();
    private readonly recentChangeFingerprints = new Map<string, string>();
    private readonly maxPolledDirectories: number;
    private readonly pollIntervalMs: number;
    private readonly watchHub: WatchHub;
    private readonly ownsWatchHub: boolean;
    private readonly onRootUnavailable?: (sessionId: string) => void;
    private watchedRoot?: string;

    constructor(
        private readonly resolveSessionPath: ResolveSessionPath,
        private readonly emit: (event: ServerEvent) => void,
        private readonly logger: StructuredLogger,
        options: WatcherServiceOptions = {},
    ) {
        this.maxPolledDirectories = options.maxPolledDirectories ?? MAX_POLLED_DIRECTORIES;
        this.pollIntervalMs = options.pollIntervalMs ?? WATCH_POLL_INTERVAL_MS;
        this.ownsWatchHub = !options.watchHub;
        this.watchHub = options.watchHub ?? new WatchHub({ logger, subscribe: options.subscribe });
        this.onRootUnavailable = options.onRootUnavailable;
        this.externalLinks = new ExternalLinkWatcher(
            options.resolveWorkspacePath ?? resolveSessionPath,
            this.watchHub,
            this.pollIntervalMs,
            (scope, change) => this.queueFingerprintedEvent(scope, change.kind, change.path),
            (scope) => this.triggerRescan(scope),
        );
    }

    /**
     * Builds `this.watchSetup` and assigns it synchronously (not via `async`/`await`) so that `watchSession` observes
     * the in-flight setup Promise on the same instance field it just wrote, before any awaited step of `replaceWatcher`
     * has a chance to run.
     */
    private installWatcher(scope: WatchScope | undefined, generation: number): Promise<void> {
        const attempt = this.replaceWatcher(scope, generation);
        // eslint-disable-next-line unicorn/prefer-await -- see class member docstring above
        const handled = attempt.catch((error: unknown) => {
            if (scope) this.onRootUnavailable?.(scope.sessionId);
            this.logger.write('warn', logEventCatalog.watcher.setupFailed, {
                fields: {
                    sessionId: scope?.sessionId ?? 'none',
                    error: errorMessage(error, 'unknown watcher error'),
                },
            });
        });
        // eslint-disable-next-line unicorn/prefer-await -- see class member docstring above
        const setup = handled.finally(() => {
            if (generation === this.watchGeneration && this.watchSetup === setup)
                this.watchSetup = undefined;
        });
        this.watchSetup = setup;
        return setup;
    }

    private async replaceWatcher(scope: WatchScope | undefined, generation: number): Promise<void> {
        const startedAt = performance.now();
        const previousHandle = this.watchHandle;
        this.watchHandle = undefined;
        const previousDisposal = previousHandle?.dispose();
        if (!scope || generation !== this.watchGeneration) {
            await previousDisposal;
            return;
        }
        /**
         * Root authorization and old native-subscription disposal are independent. Start both together, but await both
         * before registering the replacement, so generation fencing is preserved without serializing two filesystem
         * round trips on the watcher-ready critical path.
         */
        const [, { root }] = await Promise.all([
            previousDisposal,
            this.resolveSessionPath(scope.sessionId),
        ]);
        if (generation !== this.watchGeneration) return;
        this.watchedRoot = root;
        rememberPolledDirectory(
            this.listedDirectories,
            root,
            true,
            root,
            this.maxPolledDirectories,
        );
        const handle = await this.watchHub.register({
            label: 'files-root',
            root,
            ignore: WATCHER_EXCLUDE_PATTERNS,
            onEvents: (events) => {
                if (generation !== this.watchGeneration) return;
                const eventScope = this.watchedScope;
                if (!eventScope) return;
                let isRootDeleted = false;
                for (const event of events) {
                    const relativePath = relative(root, event.path);
                    if (isOutsideRoot(relativePath) || isTraversalExcludedPath(relativePath))
                        continue;
                    if (relativePath === '' && event.type === 'delete') {
                        // Queue before Workbench validation can replace the watcher generation.
                        this.queueFingerprintedEvent(eventScope, 'delete', event.path, MISSING);
                        isRootDeleted = true;
                        continue;
                    }
                    this.queueNativeEventInBackground(
                        eventScope,
                        event.type,
                        event.path,
                        generation,
                    );
                }
                if (isRootDeleted) this.onRootUnavailable?.(eventScope.sessionId);
            },
            onError: (error, erroredHandle) => {
                if (generation !== this.watchGeneration) return;
                const eventScope = this.watchedScope;
                if (!eventScope) return;
                this.onRootUnavailable?.(eventScope.sessionId);
                this.logger.write('warn', logEventCatalog.watcher.fallback, {
                    fields: {
                        sessionId: eventScope.sessionId,
                        error: errorMessage(error, 'unknown watcher error'),
                    },
                });
                erroredHandle.startFallback(error);
            },
            onRescan: () => {
                if (generation !== this.watchGeneration) return;
                const eventScope = this.watchedScope;
                if (!eventScope) return;
                this.triggerRescan(eventScope);
            },
            /**
             * Signature-polling fallback over the root and user-expanded directories when the native backend cannot be
             * installed; the hub owns the timer, this service owns the directory signatures.
             */
            fallback: {
                intervalMs: this.pollIntervalMs,
                activate: () => this.activatePollingState(generation),
                pollOnce: async () => {
                    const currentScope = this.watchedScope;
                    if (!currentScope) return;
                    await this.pollDirectories(currentScope, generation);
                    // In-root rule files may live in directories the user never expanded (and thus are absent from
                    // `polledDirectories`), so the fallback must fingerprint them by exact path or their edits would
                    // go unnoticed until the native backend recovers.
                    await this.pollGitIgnoreRuleFiles(
                        currentScope,
                        generation,
                        this.inRootRulePaths(),
                    );
                },
            },
        });
        if (generation !== this.watchGeneration) {
            await handle.dispose();
            return;
        }
        this.watchHandle = handle;
        this.logger.write('info', logEventCatalog.watcher.ready, {
            durationMs: performance.now() - startedAt,
            fields: {
                sessionId: scope.sessionId,
                backend: handle.mode === 'native' ? NATIVE_WATCHER_BACKEND : 'poll',
            },
        });
    }

    /**
     * Primes the fallback directory signatures for the current generation before the hub starts the poll loop.
     */
    private async activatePollingState(generation: number): Promise<void> {
        if (generation !== this.watchGeneration || this.pollingActive) return;
        this.pollingActive = true;
        await mapWithConcurrency(
            this.listedDirectories.keys().toArray(),
            MAX_CONCURRENT_POLL_DIRECTORIES,
            (directory) => this.initializePolledDirectory(directory, generation),
        );
    }

    /**
     * The native watcher's event callback is synchronous, so each raw event cannot be awaited before fingerprinting it;
     * queueing is deliberately fire-and-forget. `queueNativeEvent` already handles every failure internally (a missing
     * path falls back to a stable fingerprint). Kept as its own method (rather than a promise chain inline in the
     * watcher's event callback) to isolate the fire-and-forget promise handling.
     */
    private queueNativeEventInBackground(
        scope: WatchScope,
        kind: FileChange['kind'],
        path: string,
        generation: number,
    ): void {
        // eslint-disable-next-line unicorn/prefer-await -- see class member docstring above
        this.queueNativeEvent(scope, kind, path, generation).catch(() => {});
    }

    private async queueNativeEvent(
        scope: WatchScope,
        kind: FileChange['kind'],
        path: string,
        generation: number,
    ): Promise<void> {
        let fingerprint = MISSING;
        try {
            fingerprint = fileSignature(await lstat(path));
        } catch {
            /**
             * Missing paths share a stable fingerprint so native and polling delete events coalesce.
             */
        }
        if (generation !== this.watchGeneration) return;
        this.queueFingerprintedEvent(
            scope,
            fingerprint === MISSING ? 'delete' : kind,
            path,
            fingerprint,
        );
    }

    private queueFingerprintedEvent(
        scope: WatchScope,
        kind: FileChange['kind'],
        path: string,
        fingerprint?: string,
    ): void {
        if (
            fingerprint !== undefined &&
            !didFingerprintChange(
                this.recentChangeFingerprints,
                path,
                fingerprint,
                MAX_RECENT_CHANGE_FINGERPRINTS,
            )
        )
            return;
        this.preparePendingBatch(scope);
        /**
         * In-root Git rule files (`.gitignore` and friends) are detected here, from the same native/polled event stream
         * as every other change, instead of a dedicated rule-file poll loop; only rule files the Project watcher can
         * never observe (outside the root or inside `.git`) keep a poller (`noteGitIgnoreRulePaths`).
         */
        if (
            fingerprint !== undefined &&
            (isWorkingTreeGitIgnore(path) || this.gitIgnoreRuleFingerprints.has(path))
        ) {
            if (this.gitIgnoreRuleFingerprints.has(path))
                this.gitIgnoreRuleFingerprints.set(path, fingerprint);
            this.gitIgnoreRulesChanged = true;
        }
        if (this.pendingEvents.has(path) || this.pendingEvents.size < MAX_PENDING_WATCH_EVENTS) {
            const pendingKind = this.pendingEvents.get(path);
            /**
             * Creating and then writing a file can produce two fingerprints inside one batch. Preserve the create
             * transition so consumers see the path move from absent to present instead of only its final write.
             */
            const batchedKind = pendingKind === 'create' && kind === 'update' ? pendingKind : kind;
            this.pendingEvents.set(path, batchedKind);
        } else {
            this.droppedEvents += 1;
        }
        this.scheduleEventBatch();
    }

    private queueGitIgnoreRuleChange(scope: WatchScope): void {
        this.preparePendingBatch(scope);
        this.gitIgnoreRulesChanged = true;
        this.scheduleEventBatch();
    }

    /**
     * Freezes a batch scope before any event, overflow, or Git-rule state can be written.
     */
    private preparePendingBatch(scope: WatchScope): void {
        if (
            this.pendingScope &&
            (this.pendingScope.sessionId !== scope.sessionId ||
                this.pendingScope.workbenchProjectId !== scope.workbenchProjectId)
        )
            this.flushPendingBatch();
        this.pendingScope ??= scope;
    }

    private scheduleEventBatch(): void {
        this.eventTimer ??= setTimeout(() => this.flushPendingBatch(), WATCH_BATCH_DELAY_MS);
    }

    /**
     * Emits the current immutable batch before a scope or watcher generation can be discarded.
     */
    private flushPendingBatch(): void {
        if (this.eventTimer) clearTimeout(this.eventTimer);
        this.eventTimer = undefined;
        const scope = this.pendingScope;
        if (!scope) return;
        const changes = [...this.pendingEvents].map(([eventPath, eventKind]) => ({
            path: eventPath,
            kind: eventKind,
        }));
        this.emit({
            event: 'files.changed',
            payload: {
                sessionId: scope.sessionId,
                workbenchProjectId: scope.workbenchProjectId,
                changes,
                overflow: this.droppedEvents > 0 || this.forceRescanOverflow,
                ...(this.gitIgnoreRulesChanged && { gitIgnoreRulesChanged: true as const }),
            },
        });
        this.logger.write(
            this.droppedEvents > 0 ? 'warn' : 'debug',
            logEventCatalog.watcher.batch,
            {
                fields: {
                    sessionId: scope.sessionId,
                    workbenchProjectId: scope.workbenchProjectId,
                    count: this.pendingEvents.size,
                    droppedEvents: this.droppedEvents,
                    gitIgnoreRulesChanged: this.gitIgnoreRulesChanged,
                },
            },
        );
        this.pendingEvents.clear();
        this.droppedEvents = 0;
        this.forceRescanOverflow = false;
        this.gitIgnoreRulesChanged = false;
        this.pendingScope = undefined;
    }

    /**
     * Reacts to a native "must rescan" advisory (see `isMustRescanAdvisory` in `watch-hub.ts`) by asking every Files
     * consumer to refetch this scope, without disturbing the still-live native subscription or Session validation. No
     * `onRootUnavailable` call here: the root is not unavailable, the advisory just means the incremental change list
     * the native backend was about to hand us cannot be trusted for one batch.
     */
    private triggerRescan(scope: WatchScope): void {
        this.preparePendingBatch(scope);
        this.forceRescanOverflow = true;
        this.scheduleEventBatch();
    }

    private async readPathFingerprint(path: string): Promise<string> {
        try {
            return fileSignature(await lstat(path));
        } catch {
            return MISSING;
        }
    }

    /**
     * Rule files inside the watched root, i.e. every noted rule path that does not require the external poller.
     */
    private inRootRulePaths(): string[] {
        return this.gitIgnoreRuleFingerprints
            .keys()
            .filter((path) => !this.externalRulePaths.has(path))
            .toArray();
    }

    private async pollGitIgnoreRuleFiles(
        scope: WatchScope,
        generation: number,
        paths: readonly string[],
    ): Promise<void> {
        if (
            paths.length === 0 ||
            this.gitIgnoreRulePollInFlight ||
            generation !== this.watchGeneration
        )
            return;
        this.gitIgnoreRulePollInFlight = true;
        try {
            const fingerprints = await mapWithConcurrency(
                paths,
                MAX_CONCURRENT_POLL_DIRECTORIES,
                async (path) => ({
                    current: await this.readPathFingerprint(path),
                    path,
                    previous: this.gitIgnoreRuleFingerprints.get(path),
                }),
            );
            if (generation !== this.watchGeneration) return;
            let isChanged = false;
            for (const fingerprint of fingerprints) {
                if (fingerprint.current === fingerprint.previous) continue;
                this.gitIgnoreRuleFingerprints.set(fingerprint.path, fingerprint.current);
                isChanged = true;
            }
            if (isChanged) this.queueGitIgnoreRuleChange(scope);
        } finally {
            if (generation === this.watchGeneration) this.gitIgnoreRulePollInFlight = false;
        }
    }

    /**
     * Reads directory-entry signatures for the polling fallback, tolerating entries that vanish between `readdir` and
     * `lstat` the same way `ListingService` does: a single missing or unreadable entry is skipped rather than failing
     * the whole signature scan.
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
                        this.logger.write('debug', logEventCatalog.watcher.signatureEntrySkipped, {
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

    /**
     * Poll only the root and directories the user expanded, bounding fallback work in large repositories.
     */
    private async pollDirectories(scope: WatchScope, generation: number): Promise<void> {
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
                        if (directory === this.watchedRoot)
                            this.onRootUnavailable?.(scope.sessionId);
                        return;
                    }
                    if (generation !== this.watchGeneration) return;
                    for (const [path, signature] of current) {
                        if (previous.get(path) !== signature) {
                            this.queueFingerprintedEvent(
                                scope,
                                previous.has(path) ? 'update' : 'create',
                                path,
                                signature,
                            );
                        }
                    }
                    for (const path of previous.keys()) {
                        if (!current.has(path))
                            this.queueFingerprintedEvent(scope, 'delete', path, MISSING);
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

    /**
     * Rule files the Project watcher can never observe: outside the watched root (e.g. the global Git ignore file) or
     * inside `.git` (e.g. `info/exclude`), which stays excluded from the root subscription by design.
     */
    private isExternalRulePath(path: string): boolean {
        if (!this.watchedRoot) return true;
        const relativePath = relative(this.watchedRoot, path);
        return isOutsideRoot(relativePath) || isTraversalExcludedPath(relativePath);
    }

    private resetWatchState(): void {
        if (this.eventTimer) clearTimeout(this.eventTimer);
        this.eventTimer = undefined;
        this.pendingEvents.clear();
        this.pendingScope = undefined;
        this.droppedEvents = 0;
        this.forceRescanOverflow = false;
        this.gitIgnoreRulesChanged = false;
        const ruleHandle = this.ruleWatchHandle;
        this.ruleWatchHandle = undefined;
        // Disposal never rejects and this synchronous reset path must not await it.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see comment above
        void ruleHandle?.dispose();
        this.gitIgnoreRulePollInFlight = false;
        this.pollingActive = false;
        this.listedDirectories.clear();
        this.gitIgnoreRuleFingerprints.clear();
        this.externalRulePaths.clear();
        this.polledDirectories.clear();
        this.recentChangeFingerprints.clear();
        this.watchedRoot = undefined;
    }

    /**
     * Primes fallback polling for a directory the moment it is listed, without waiting for the poll tick.
     */
    noteDirectoryListed(sessionId: string, path: string): void {
        if (sessionId !== this.watchedScope?.sessionId) return;
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
        /**
         * `noteDirectoryListed` is a synchronous notification hook called from `ListingService` mid-listing; it cannot
         * await the directory's initial signature scan without blocking the caller, so priming a newly listed directory
         * is deliberately fire-and-forget. `initializePolledDirectory` already handles every failure internally.
         */
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        else this.initializePolledDirectory(path, this.watchGeneration).catch(() => {});
    }

    /**
     * Tracks the explicit Git rule files resolved by Git. In-root rule files are detected from the regular watcher
     * event stream (`queueFingerprintedEvent`); only external rule files (see {@link isExternalRulePath}) get a bounded
     * poller, registered through the watch hub, because no watched event stream can cover them: polling them directly
     * keeps the `.git` tree unwatched by the files domain.
     */
    async noteGitIgnoreRulePaths(sessionId: string, paths: readonly string[]): Promise<void> {
        if (sessionId !== this.watchedScope?.sessionId) return;
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
        // `this.watchedScope` can change while `mapWithConcurrency` above is awaited (another Session
        // switch or watch stop); the generation/scope re-check here guards against applying stale
        // fingerprints, so it must run even though the checker narrows the scope from line 616.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- watchedScope can change during the preceding await
        if (generation !== this.watchGeneration || sessionId !== this.watchedScope?.sessionId)
            return;
        for (const [path, fingerprint] of fingerprints) {
            this.gitIgnoreRuleFingerprints.set(path, fingerprint);
            if (this.isExternalRulePath(path)) this.externalRulePaths.add(path);
        }
        if (this.externalRulePaths.size === 0 || this.ruleWatchHandle) return;
        this.ruleWatchHandle = this.watchHub.registerPoller({
            label: 'files-git-rules',
            intervalMs: this.pollIntervalMs,
            pollOnce: async () => {
                const currentScope = this.watchedScope;
                if (currentScope)
                    await this.pollGitIgnoreRuleFiles(
                        currentScope,
                        generation,
                        this.externalRulePaths.values().toArray(),
                    );
            },
        });
    }

    watchSession(scope?: WatchScope, shouldForce = false): Promise<void> {
        if (
            shouldForce ||
            scope?.sessionId !== this.watchedScope?.sessionId ||
            scope?.workbenchProjectId !== this.watchedScope?.workbenchProjectId
        ) {
            // Reset fences synchronously; hub disposal never rejects and must not delay root setup.
            // eslint-disable-next-line no-void -- synchronous generation invalidation
            void this.externalLinks.reset(scope);
        }
        if (
            scope &&
            !shouldForce &&
            scope.workbenchProjectId === this.watchedScope?.workbenchProjectId
        ) {
            this.watchedScope = scope;
            return this.watchSetup ?? Promise.resolve();
        }
        this.flushPendingBatch();
        const generation = ++this.watchGeneration;
        this.watchedScope = scope;
        this.resetWatchState();
        this.watchSetup = this.installWatcher(scope, generation);
        return this.watchSetup;
    }

    noteWorkspacePath(sessionId: string, resolved: ResolvedSessionPath): Promise<void> {
        return this.externalLinks.note(sessionId, resolved);
    }

    async close(): Promise<void> {
        await this.externalLinks.reset();
        this.flushPendingBatch();
        this.watchGeneration += 1;
        this.pollingActive = false;
        const ruleHandle = this.ruleWatchHandle;
        this.ruleWatchHandle = undefined;
        const handle = this.watchHandle;
        const setup = this.watchSetup;
        this.watchHandle = undefined;
        this.pendingScope = undefined;
        this.listedDirectories.clear();
        this.gitIgnoreRuleFingerprints.clear();
        this.externalRulePaths.clear();
        this.polledDirectories.clear();
        this.recentChangeFingerprints.clear();
        await Promise.allSettled([handle?.dispose(), ruleHandle?.dispose(), setup]);
        if (this.ownsWatchHub) await this.watchHub.close();
    }
}
