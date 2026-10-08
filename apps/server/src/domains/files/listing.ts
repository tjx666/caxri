import { Buffer } from 'node:buffer';
import type { Dirent } from 'node:fs';
import { lstat, opendir, readlink, realpath, stat } from 'node:fs/promises';
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

/**
 * Directories and symlinks that resolve to a directory share the leading group, so a linked folder sorts beside the
 * real folders it belongs with instead of drifting into the file list.
 */
function fileEntryGroup(entry: FileEntry): number {
    return entry.kind === 'directory' || entry.linkKind === 'directory' ? 0 : 1;
}

/**
 * Ranking the group before comparing names keeps the comparator antisymmetric. Comparing `kind` pairwise did not: a
 * `file`/`symlink` pair answered `1` in both directions, so the surviving order depended on `readdir` order.
 */
export function compareFileEntries(a: FileEntry, b: FileEntry): number {
    const groupDifference = fileEntryGroup(a) - fileEntryGroup(b);
    return groupDifference === 0 ? a.name.localeCompare(b.name) : groupDifference;
}

/**
 * Following a symlink is the only step of a listing that can leave the enumerated directory's own filesystem, so it is
 * the only step that can block on an unresponsive mount such as a stale network share.
 */
const SYMLINK_TARGET_PROBE_TIMEOUT_MS = 2_000;
/**
 * Ceiling on what one listing may spend waiting on symlink targets in total, across every link in it.
 *
 * A mount that is slow but alive never reaches the per-probe timeout, so before this existed the budget could not be
 * spent at all: every browse re-issued up to `MAX_CONCURRENT_ENTRY_STATS` × 2 uncancellable `stat`/`readlink` calls,
 * and `files.browse` runs on every keystroke in the Cmd+P path input. Half the single-probe ceiling: two probes that
 * each take a second are already a listing nobody is waiting for.
 */
const SYMLINK_TARGET_PROBE_BUDGET_MS = 1_000;

/**
 * Why a listing stopped following symlink targets. `probe_timeout` is one target that never answered; `cumulative_wait`
 * is many that each answered slowly. They call for different responses (a hung mount versus a slow one), so they are
 * recorded apart rather than as one "budget spent".
 */
type SymlinkProbeBudgetReason = 'cumulative_wait' | 'probe_timeout';

export type SymlinkTargetProbe = <T>(read: () => Promise<T>) => Promise<T | undefined>;

export interface SymlinkTargetProbeOptions {
    budgetMs?: number;
    /**
     * Called once, the first time a listing's budget closes. Not called when the listing stays inside it.
     */
    onBudgetSpent?: (reason: SymlinkProbeBudgetReason, waitedMs: number) => void;
    timeoutMs?: number;
}

/**
 * Probes a symlink target for optional display metadata under a per-listing budget. A dangling or racing symlink is an
 * ordinary state to render, so a failed probe answers `undefined` instead of failing the surrounding listing.
 *
 * The budget is load-bearing rather than defensive. `fs.stat` cannot be cancelled, so a target on a hung mount would
 * leave `loadList` pending forever; `SingleFlight` evicts a request only when it settles, so every later listing of
 * that directory would join the dead promise and time out, with no recovery short of restarting Server Core. Spending
 * the budget for the rest of the listing keeps one unhealthy mount to a single wait instead of pinning a libuv
 * threadpool thread per symlink and starving every other file operation. An unprobed link keeps the neutral icon it had
 * before target resolution existed.
 *
 * Two things close it, because a mount can be unreachable or merely slow and only the first reaches a per-probe
 * ceiling: one probe exceeding `timeoutMs`, or the probes so far having waited `budgetMs` in total.
 */
export function createSymlinkTargetProbe({
    budgetMs = SYMLINK_TARGET_PROBE_BUDGET_MS,
    onBudgetSpent,
    timeoutMs = SYMLINK_TARGET_PROBE_TIMEOUT_MS,
}: SymlinkTargetProbeOptions = {}): SymlinkTargetProbe {
    // Held in one object, and read back through a function, because the timer callback writes both fields while the
    // probe below is suspended at its `await`. Reading the property directly lets TypeScript narrow it to `undefined`
    // across that suspension and then call the check in `finally` unreachable, which is the one mutation that does
    // happen here.
    const budget = { spentReason: undefined as SymlinkProbeBudgetReason | undefined, waitedMs: 0 };
    const isBudgetSpent = (): boolean => budget.spentReason !== undefined;
    const spend = (reason: SymlinkProbeBudgetReason): void => {
        if (isBudgetSpent()) return;
        budget.spentReason = reason;
        onBudgetSpent?.(reason, budget.waitedMs);
    };
    return async <T>(read: () => Promise<T>): Promise<T | undefined> => {
        if (isBudgetSpent()) return undefined;
        const startedAt = performance.now();
        const expiry = Promise.withResolvers<undefined>();
        const timer = setTimeout(() => {
            budget.waitedMs += performance.now() - startedAt;
            spend('probe_timeout');
            expiry.resolve(undefined);
        }, timeoutMs);
        try {
            return await Promise.race([read(), expiry.promise]);
        } catch {
            return undefined;
        } finally {
            clearTimeout(timer);
            if (!isBudgetSpent()) {
                budget.waitedMs += performance.now() - startedAt;
                if (budget.waitedMs >= budgetMs) spend('cumulative_wait');
            }
        }
    };
}

/**
 * Reads a symlink's raw target plus one `stat` so the Renderer can pick a folder or typed-file icon instead of an
 * untyped placeholder. The single follow only asks the target's type: it never enumerates the target, never resolves it
 * against the Project root, and never relaxes the rule that Caxri refuses to browse, expand, or mutate through a
 * symlink. A link whose target cannot be described within the listing's probe budget simply reports neither field.
 */
export async function describeSymlink(
    entryPath: string,
    name: string,
    probeTarget: SymlinkTargetProbe,
): Promise<FileEntry> {
    const [linkTarget, linkKind] = await Promise.all([
        probeTarget(() => readlink(entryPath)),
        probeTarget(async () => {
            try {
                return (await stat(entryPath)).isDirectory()
                    ? ('directory' as const)
                    : ('file' as const);
            } catch {
                // A dangling link is an ordinary state to display, not an unanswered probe.
                return 'broken' as const;
            }
        }),
    ]);
    return {
        name,
        path: entryPath,
        kind: 'symlink',
        ...(linkKind !== undefined && { linkKind }),
        ...(linkTarget !== undefined && { linkTarget }),
    };
}

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
export type DirectoryListedListener = (
    sessionId: string,
    path: string,
    resolved: { root: string; path: string; workspacePath: string },
) => Promise<void> | void;
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

export interface ListingServiceOptions {
    /**
     * Seam for tests: overriding the factory spends a listing's symlink budget in milliseconds instead of waiting out
     * the real hung-mount timeout. It still receives the service's `onBudgetSpent`, so an override exercises the same
     * record a real budget produces.
     */
    createSymlinkTargetProbe?: (options: SymlinkTargetProbeOptions) => SymlinkTargetProbe;
}

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

    /**
     * Factory behind every listing's single symlink budget; see {@link ListingServiceOptions}.
     */
    private readonly createProbe: (options: SymlinkTargetProbeOptions) => SymlinkTargetProbe;

    /**
     * How many listings have spent their symlink budget since this process started. A per-listing record alone cannot
     * answer "is this happening at all", which is the question a slow mount raises: each one looks isolated, and the
     * volume is the symptom.
     */
    private symlinkProbeBudgetSpentCount = 0;

    constructor(
        private readonly resolveSessionPath: ResolveSessionPath,
        private readonly logger: StructuredLogger,
        private readonly fileTreeExcludes: () => FileTreeExcludes,
        private readonly onDirectoryListed?: DirectoryListedListener,
        private readonly decorateGitIgnored?: GitIgnoreDecorator,
        private readonly onGitIgnoreRulesListed?: GitIgnoreRulesListedListener,
        private readonly openDirectory: OpenDirectory = opendir,
        options: ListingServiceOptions = {},
    ) {
        this.createProbe = options.createSymlinkTargetProbe ?? createSymlinkTargetProbe;
    }

    /**
     * One symlink budget for one listing, wired to the record that makes spending it visible.
     *
     * The record is the point of the closed reason enum and the running count: an unprobed link is invisible in the
     * result (it just keeps the neutral icon), so without this a slow mount degrades the path browser silently, and
     * "how often" is the only thing that distinguishes a stale share from a one-off.
     *
     * @param sessionId Session whose listing owns this budget.
     * @param relativeDirectory The listed directory relative to the Project root, never the absolute path.
     */
    private createSymlinkProbe(sessionId: string, relativeDirectory: string): SymlinkTargetProbe {
        return this.createProbe({
            onBudgetSpent: (reason, waitedMs) => {
                this.symlinkProbeBudgetSpentCount += 1;
                this.logger.write('debug', logEventCatalog.file.symlinkProbeBudgetSpent, {
                    durationMs: waitedMs,
                    fields: {
                        sessionId,
                        path: relativeDirectory,
                        reason,
                        spentCount: this.symlinkProbeBudgetSpentCount,
                    },
                });
            },
        });
    }

    private async loadBrowse(
        { sessionId, directory, query }: ServerOperationParameters<'files.browse'>,
        excludes: FileTreeExcludes,
        isCurrent: () => boolean,
    ): Promise<ServerOperationResult<'files.browse'>> {
        const startedAt = performance.now();
        const {
            root,
            path,
            workspacePath = path,
        } = await this.resolveSessionPath(sessionId, directory);
        if (!isCurrent()) return { entries: [], truncated: true };
        await this.onDirectoryListed?.(sessionId, workspacePath, { root, path, workspacePath });
        const before = await lstat(path);
        if (!before.isDirectory() || before.isSymbolicLink())
            throw new CaxriError('IO', 'Path is not a directory');
        const normalizedQuery = query.toLocaleLowerCase();
        const matches: FileEntry[] = [];
        /**
         * Where each matched symlink landed in `matches`, so one bounded round of target probes can replace those rows
         * in place after the enumeration closes its directory handle.
         */
        const linkPositions: Array<{ index: number; name: string; path: string }> = [];
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
                const entryPath = resolve(path, entry.name);
                const relativePath = relative(root, resolve(workspacePath, entry.name))
                    .split(sep)
                    .join('/');
                if (
                    isFileTreeExcludeMatch(relativePath, excludes) ||
                    !entry.name.toLocaleLowerCase().includes(normalizedQuery)
                )
                    continue;
                const kind = entry.isSymbolicLink()
                    ? 'symlink'
                    : entry.isDirectory()
                      ? 'directory'
                      : 'file';
                if (kind === 'symlink')
                    linkPositions.push({
                        index: matches.length,
                        name: entry.name,
                        path: entryPath,
                    });
                matches.push({ name: entry.name, path: entryPath, kind });
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
        if (!isCurrent()) return { entries: [], truncated: true };
        const isTruncated = !isReachedEnd || matches.length > MAX_FILE_BROWSE_ENTRIES;
        /**
         * Regular entries are still described from `Dirent` metadata alone: browsing never restats a name it already
         * read from the opened directory handle, so a path swapped mid-enumeration cannot retype its own row.
         *
         * A symlink row is the deliberate exception, and this is where the browse threat model was relaxed. A link's
         * own name carries no type and `Dirent` cannot say whether the target is a folder or a file, so without a
         * follow every link renders as an untyped placeholder in the path-browser dialog. Each matched link therefore
         * gets exactly one type-only follow through this listing's shared `createSymlinkTargetProbe` budget. VS Code's
         * own directory enumeration takes the same follow for the same reason
         * (`competitors/vscode/src/vs/platform/files/node/diskFileSystemProvider.ts:115-138`, "always resolve target
         * the link points to if any"). Opening or expanding a trusted workspace link is a separate request; this probe
         * only asks the target's type. One budget per browse keeps an unresponsive mount to a single timeout for the
         * whole listing instead of one stalled follow per link.
         *
         * Ordering follows from the same metadata: `compareFileEntries` groups a `directory` link with the real
         * directories, so browse results now sort links the way the Files tree does instead of dropping every link into
         * the file group.
         */
        const probeTarget = this.createSymlinkProbe(
            sessionId,
            relative(root, workspacePath) || '.',
        );
        const describedLinks = await mapWithConcurrency(
            linkPositions,
            MAX_CONCURRENT_ENTRY_STATS,
            ({ name, path: linkPath }) => describeSymlink(linkPath, name, probeTarget),
        );
        for (const [position, entry] of describedLinks.entries())
            matches[linkPositions[position].index] = entry;
        const entries = matches.toSorted(compareFileEntries).slice(0, MAX_FILE_BROWSE_ENTRIES);
        this.logger.write('info', logEventCatalog.file.browse, {
            durationMs: performance.now() - startedAt,
            fields: {
                sessionId,
                path: relative(root, workspacePath) || '.',
                entryCount: entries.length,
                scannedEntries,
                truncated: isTruncated,
            },
        });
        return {
            entries: entries.map((entry) => ({
                ...entry,
                path: resolve(workspacePath, entry.name),
            })),
            truncated: isTruncated,
        };
    }

    private async loadList(
        sessionId: string,
        directory: string | undefined,
        excludes: FileTreeExcludes,
    ): Promise<ServerOperationResult<'files.list'>> {
        const startedAt = performance.now();
        const {
            root,
            path,
            workspacePath = path,
        } = await this.resolveSessionPath(sessionId, directory);
        await this.onDirectoryListed?.(sessionId, workspacePath, { root, path, workspacePath });
        const before = await lstat(path);
        if (!before.isDirectory() || before.isSymbolicLink())
            throw new CaxriError('IO', 'Path is not a directory');
        let scan = await this.readDirectoryEntries(path);
        let emptyRootVerification: { scannedEntries: number } | undefined;
        if (path === root && scan.scannedEntries === 0) {
            /**
             * A CI root listing reported EOF when its fixture expected a child, but the physical root identity was not
             * recorded. A second bounded handle can recover from a transient false EOF without emptying the Files
             * tree.
             */
            const verification = await this.readDirectoryEntries(path);
            emptyRootVerification = { scannedEntries: verification.scannedEntries };
            if (verification.scannedEntries > 0) scan = verification;
        }
        const { entries, isReachedEnd, scannedEntries } = scan;
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
            const relativePath = relative(root, resolve(workspacePath, entry.name))
                .split(sep)
                .join('/');
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
        // One budget per listing, so a hung mount stops being probed after the first slow symlink in this directory.
        const probeTarget = this.createSymlinkProbe(
            sessionId,
            relative(root, workspacePath) || '.',
        );
        const [settled, gitIgnoreDecoration] = await Promise.all([
            mapWithConcurrency(boundedVisible, MAX_CONCURRENT_ENTRY_STATS, (entry) =>
                this.describeEntry(path, entry.name, probeTarget),
            ),
            this.loadGitIgnoredNames(
                sessionId,
                workspacePath,
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
        const sorted = result
            .map((entry) => ({ ...entry, path: resolve(workspacePath, entry.name) }))
            .toSorted(compareFileEntries);
        const bounded = boundFileListEntries(sorted);
        const isTruncated =
            !isReachedEnd ||
            visible.length > boundedVisible.length ||
            bounded.length < sorted.length;
        this.logger.write('info', logEventCatalog.file.list, {
            durationMs: performance.now() - startedAt,
            fields: {
                sessionId,
                path: relative(root, workspacePath) || '.',
                entryCount: bounded.length,
                scannedEntries,
                truncated: isTruncated,
                ...(path === root && { device: before.dev, inode: before.ino }),
                ...(emptyRootVerification && {
                    initialScannedEntries: 0,
                    verificationScannedEntries: emptyRootVerification.scannedEntries,
                }),
            },
        });
        return {
            entries: bounded,
            truncated: isTruncated,
        };
    }

    private async readDirectoryEntries(path: string): Promise<{
        entries: Dirent[];
        isReachedEnd: boolean;
        scannedEntries: number;
    }> {
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
        return { entries, isReachedEnd, scannedEntries };
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
    private async describeEntry(
        directory: string,
        name: string,
        probeTarget: SymlinkTargetProbe,
    ): Promise<FileEntry | undefined> {
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
        if (stats.isSymbolicLink()) return describeSymlink(entryPath, name, probeTarget);
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
