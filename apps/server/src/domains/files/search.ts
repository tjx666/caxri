import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import type {
    FileSearchMatch,
    ServerOperationParameters,
    ServerOperationResult,
} from '@caxri/protocol';
import { CaxriError, errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { AsyncSemaphore, logEventCatalog } from '@caxri/system';

import type { ResolveSessionPath } from './documents';
import { isTraversalExcludedName } from './ignore-rules';
import { runRipgrepSearch } from './ripgrep';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESULTS = 500;
const DEFAULT_MAX_SCANNED_FILES = 50_000;
const DEFAULT_MAX_SCANNED_DIRECTORIES = 50_000;
const MAX_CONCURRENT_PROJECT_SEARCHES = 4;

export interface SearchServiceOptions {
    executablePath?: string;
    timeoutMs?: number;
    maxResults?: number;
    maxScannedFiles?: number;
    maxScannedDirectories?: number;
    workerPath?: string;
}

/**
 * `file` matches only regular single-link files (Terminal link resolution); `directory` matches only real directories
 * (path-browser subpath fallback). Symbolic links never match either kind.
 */
export type ProjectSuffixLeafKind = 'directory' | 'file';

export interface ProjectFileSuffixSearchResult {
    matches: FileSearchMatch[];
    scannedDirectories: number;
    truncated: boolean;
    canceled: boolean;
}

interface SuffixProbeResult {
    paths: string[];
    scannedDirectories: number;
    truncated: boolean;
}

type SearchParameters = ServerOperationParameters<'files.search'>;
type SearchResult = ServerOperationResult<'files.search'>;

function normalizedRelative(root: string, path: string): string {
    return relative(root, path).split(sep).join('/');
}

function isSearchCanceled(signal: AbortSignal): boolean {
    return signal.aborted;
}

/**
 * Bounded, Session-rooted Project search with latest-request cancellation per Session and consumer.
 */
export class SearchService {
    private readonly active = new Map<string, AbortController>();
    private readonly executions = new AsyncSemaphore(MAX_CONCURRENT_PROJECT_SEARCHES);
    private readonly pending = new Set<Promise<SearchResult>>();
    private readonly timeoutMs: number;
    private readonly maxResults: number;
    private readonly maxScannedFiles: number;
    private readonly maxScannedDirectories: number;
    private readonly executablePath?: string;
    private readonly workerPath?: string;

    constructor(
        private readonly resolveSessionPath: ResolveSessionPath,
        private readonly logger: StructuredLogger,
        private readonly maxFileBytes: () => number,
        options: SearchServiceOptions = {},
    ) {
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
        this.maxScannedFiles = options.maxScannedFiles ?? DEFAULT_MAX_SCANNED_FILES;
        this.maxScannedDirectories =
            options.maxScannedDirectories ?? DEFAULT_MAX_SCANNED_DIRECTORIES;
        this.executablePath = options.executablePath;
        this.workerPath = options.workerPath;
    }

    private async run(
        parameters: SearchParameters,
        signal: AbortSignal,
        startedAt: number,
        authorizedRoot?: string,
    ): Promise<SearchResult> {
        const root = authorizedRoot ?? (await this.resolveSessionPath(parameters.sessionId)).root;
        const rootBefore = await lstat(root);
        if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink())
            throw new CaxriError('IO', 'Project root is not a directory');
        const { executablePath, workerPath } = this;
        if (!executablePath || !workerPath)
            throw new CaxriError('UNAVAILABLE', 'Project search engine is unavailable');
        const execution = await this.executions.run(() =>
            runRipgrepSearch(root, parameters, signal, startedAt, {
                executablePath,
                maxFileBytes: this.maxFileBytes(),
                maxResults: this.maxResults,
                maxScannedFiles: this.maxScannedFiles,
                timeoutMs: this.timeoutMs,
                workerPath,
            }),
        );

        /**
         * This snapshot must follow the completed search so it can detect a root replacement during execution.
         */
        // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
        const [rootAfter, rootRealPath] = await Promise.all([lstat(root), realpath(root)]);
        if (
            rootRealPath !== root ||
            !rootAfter.isDirectory() ||
            rootAfter.isSymbolicLink() ||
            rootBefore.dev !== rootAfter.dev ||
            rootBefore.ino !== rootAfter.ino
        )
            throw new CaxriError('IO', 'Project root changed during search');
        const isCanceled = execution.terminationReason === 'canceled';
        const sortedMatches = execution.matches.toSorted(
            (left, right) =>
                left.relativePath.localeCompare(right.relativePath) ||
                (left.line ?? 0) - (right.line ?? 0) ||
                (left.column ?? 0) - (right.column ?? 0),
        );
        const result: SearchResult = {
            mode: parameters.mode,
            matches: isCanceled ? [] : sortedMatches,
            scannedFiles: execution.scannedFiles,
            truncated: !['completed', 'canceled'].includes(execution.terminationReason),
            canceled: isCanceled,
            terminationReason: execution.terminationReason,
        };
        this.logger.write('info', logEventCatalog.file.search, {
            durationMs: performance.now() - startedAt,
            fields: {
                sessionId: parameters.sessionId,
                mode: parameters.mode,
                // Recorded because it changes which files the scan could have reached: a "no matches" outcome means
                // something different depending on whether the Project's ignore files narrowed the enumeration.
                useIgnoreFiles: parameters.useIgnoreFiles,
                scannedFiles: execution.scannedFiles,
                matchCount: result.matches.length,
                truncated: result.truncated,
                canceled: isCanceled,
                terminationReason: execution.terminationReason,
            },
        });
        return result;
    }

    private logSkipped(path: string, error: unknown): void {
        this.logger.write('debug', logEventCatalog.file.searchEntrySkipped, {
            fields: { path, error: errorMessage(error, 'unknown') },
        });
    }

    private async readStableDirectory(directory: string): Promise<Dirent[] | undefined> {
        try {
            const before = await lstat(directory);
            if (!before.isDirectory() || before.isSymbolicLink()) return;
            const entries = await readdir(directory, { withFileTypes: true });
            const after = await lstat(directory);
            if (
                !after.isDirectory() ||
                after.isSymbolicLink() ||
                before.dev !== after.dev ||
                before.ino !== after.ino ||
                (await realpath(directory)) !== directory
            )
                throw new CaxriError('IO', 'Directory changed during search');
            return entries;
        } catch (error) {
            if (error instanceof CaxriError) throw error;
            this.logSkipped(directory, error);
            return undefined;
        }
    }

    private async probeCaseInsensitiveSuffix(
        directory: string,
        entries: Dirent[],
        suffixSegments: string[],
        signal: AbortSignal,
        startedAt: number,
        maximumDirectories: number,
        maximumMatches: number,
        leafKind: ProjectSuffixLeafKind,
    ): Promise<SuffixProbeResult> {
        let states = [{ directory, entries }];
        let scannedDirectories = 0;
        const paths: string[] = [];
        for (const [index, segment] of suffixSegments.entries()) {
            const isLastSegment = index === suffixSegments.length - 1;
            const nextStates: typeof states = [];
            for (const state of states) {
                for (const entry of state.entries) {
                    if (signal.aborted) return { paths, scannedDirectories, truncated: false };
                    if (performance.now() - startedAt > this.timeoutMs)
                        return { paths, scannedDirectories, truncated: true };
                    // eslint-disable-next-line unicorn/no-break-in-nested-loop -- unmatched entries remain in this directory
                    if (entry.name.toLowerCase() !== segment.toLowerCase()) continue;
                    const path = join(state.directory, entry.name);
                    if (isLastSegment) {
                        // eslint-disable-next-line unicorn/no-break-in-nested-loop -- only leaf entries of the requested kind can match
                        if (leafKind === 'file' ? !entry.isFile() : !entry.isDirectory()) continue;
                        try {
                            // eslint-disable-next-line no-await-in-loop -- only matching suffix leaves are verified
                            const stats = await lstat(path);
                            if (
                                leafKind === 'file'
                                    ? stats.isFile() && stats.nlink === 1
                                    : stats.isDirectory()
                            )
                                paths.push(path);
                        } catch (error) {
                            this.logSkipped(path, error);
                        }
                        if (paths.length >= maximumMatches)
                            return { paths, scannedDirectories, truncated: true };
                        // eslint-disable-next-line unicorn/no-break-in-nested-loop -- leaf handling never creates a child state
                        continue;
                    }
                    // eslint-disable-next-line unicorn/no-break-in-nested-loop -- intermediate suffix segments must be directories
                    if (!entry.isDirectory()) continue;
                    if (scannedDirectories >= maximumDirectories)
                        return { paths, scannedDirectories, truncated: true };
                    // eslint-disable-next-line no-await-in-loop -- only matching suffix branches are traversed
                    const childEntries = await this.readStableDirectory(path);
                    scannedDirectories += 1;
                    if (childEntries) nextStates.push({ directory: path, entries: childEntries });
                }
            }
            if (isLastSegment) break;
            states = nextStates;
            if (states.length === 0) break;
        }
        return { paths, scannedDirectories, truncated: false };
    }

    private async executeSearch(
        parameters: SearchParameters,
        externalSignal?: AbortSignal,
    ): Promise<SearchResult> {
        const key = JSON.stringify([parameters.sessionId, parameters.consumer]);
        this.active.get(key)?.abort();
        const controller = new AbortController();
        this.active.set(key, controller);
        const cancel = (): void => controller.abort();
        if (externalSignal?.aborted) controller.abort();
        externalSignal?.addEventListener('abort', cancel, { once: true });
        const startedAt = performance.now();
        try {
            return await this.run(parameters, controller.signal, startedAt);
        } finally {
            externalSignal?.removeEventListener('abort', cancel);
            if (this.active.get(key) === controller) this.active.delete(key);
        }
    }

    async search(
        parameters: SearchParameters,
        externalSignal?: AbortSignal,
    ): Promise<SearchResult> {
        const operation = this.executeSearch(parameters, externalSignal);
        this.pending.add(operation);
        try {
            return await operation;
        } finally {
            this.pending.delete(operation);
        }
    }

    /**
     * Stops every child process or Worker before the Files domain releases its Project authority.
     */
    async close(): Promise<void> {
        for (const controller of this.active.values()) controller.abort();
        await Promise.allSettled(this.pending);
        this.active.clear();
    }

    /**
     * Finds an incomplete relative path without letting unrelated files consume the generic name-search budget. Each
     * visited directory probes the complete suffix directly, so a large sibling tree costs directories rather than
     * every file it contains. The Terminal resolver still reauthorizes every returned path before exposing it.
     */
    async searchProjectFileSuffixes(
        sessionId: string,
        root: string,
        suffix: string,
        signal: AbortSignal,
        leafKind: ProjectSuffixLeafKind = 'file',
    ): Promise<ProjectFileSuffixSearchResult> {
        const startedAt = performance.now();
        const rootBefore = await lstat(root);
        if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink())
            throw new CaxriError('IO', 'Project root is not a directory');
        const suffixSegments = suffix.split(/[\\/]/u);
        if (
            isAbsolute(suffix) ||
            suffixSegments.some((segment) => !segment || segment === '.' || segment === '..')
        )
            throw new CaxriError('VALIDATION', 'File suffix is invalid');
        if (
            suffixSegments.some(
                (segment) =>
                    isTraversalExcludedName(segment) ||
                    isTraversalExcludedName(segment.toLowerCase()),
            )
        )
            return {
                matches: [],
                scannedDirectories: 0,
                truncated: false,
                canceled: signal.aborted,
            };
        const directories = [root];
        const matches: FileSearchMatch[] = [];
        let directoryIndex = 0;
        let scannedDirectories = 0;
        let isTruncated = false;

        while (!isTruncated && !signal.aborted && directoryIndex < directories.length) {
            if (
                performance.now() - startedAt > this.timeoutMs ||
                scannedDirectories >= this.maxScannedDirectories
            ) {
                isTruncated = true;
                break;
            }
            const directory = directories[directoryIndex++];
            scannedDirectories += 1;
            // eslint-disable-next-line no-await-in-loop -- directory traversal is intentionally sequential and bounded
            const entries = await this.readStableDirectory(directory);
            if (!entries) continue;
            // eslint-disable-next-line no-await-in-loop -- each directory is searched within one shared deadline
            const probe = await this.probeCaseInsensitiveSuffix(
                directory,
                entries,
                suffixSegments,
                signal,
                startedAt,
                this.maxScannedDirectories - scannedDirectories,
                this.maxResults - matches.length,
                leafKind,
            );
            scannedDirectories += probe.scannedDirectories;
            matches.push(
                ...probe.paths.map((path) => ({
                    path,
                    relativePath: normalizedRelative(root, path),
                })),
            );
            if (probe.truncated || matches.length >= this.maxResults) {
                isTruncated = true;
                break;
            }
            for (const entry of entries) {
                // eslint-disable-next-line unicorn/no-break-in-nested-loop -- cancellation ends this directory and the outer loop
                if (isSearchCanceled(signal)) break;
                if (
                    performance.now() - startedAt > this.timeoutMs ||
                    directories.length >= this.maxScannedDirectories
                ) {
                    isTruncated = true;
                    // eslint-disable-next-line unicorn/no-break-in-nested-loop -- the shared traversal budget is exhausted
                    break;
                }
                if (entry.isDirectory() && !isTraversalExcludedName(entry.name))
                    directories.push(join(directory, entry.name));
            }
        }

        const rootAfter = await lstat(root);
        if (
            !rootAfter.isDirectory() ||
            rootAfter.isSymbolicLink() ||
            rootBefore.dev !== rootAfter.dev ||
            rootBefore.ino !== rootAfter.ino ||
            (await realpath(root)) !== root
        )
            throw new CaxriError('IO', 'Project root changed during search');
        const canceled = signal.aborted;
        this.logger.write('info', logEventCatalog.file.search, {
            durationMs: performance.now() - startedAt,
            fields: {
                sessionId,
                mode: leafKind === 'file' ? 'path-suffix' : 'directory-suffix',
                scannedDirectories,
                matchCount: canceled ? 0 : matches.length,
                truncated: canceled ? false : isTruncated,
                canceled,
            },
        });
        return {
            matches: canceled
                ? []
                : matches.toSorted((left, right) =>
                      left.relativePath.localeCompare(right.relativePath),
                  ),
            scannedDirectories,
            truncated: canceled ? false : isTruncated,
            canceled,
        };
    }
}
