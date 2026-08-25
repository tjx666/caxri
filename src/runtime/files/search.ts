import { Buffer } from 'node:buffer';
import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import { CaxriError, errorMessage } from '../../shared/ipc/errors';
import type {
    RuntimeMethodParams as RuntimeMethodParameters,
    RuntimeMethodResult,
} from '../../shared/ipc/methods';
import type { StructuredLogger } from '../../shared/node/logger';
import { logEventCatalog } from '../../shared/node/logger';
import type { FileDocument, FileSearchMatch } from '../../shared/types';
import type { ResolveSessionPath } from './documents';
import { isTraversalExcludedName } from './ignore-rules';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESULTS = 500;
const DEFAULT_MAX_SCANNED_FILES = 50_000;
const MAX_PREVIEW_LENGTH = 300;
const MAX_RESULT_PAYLOAD_BYTES = 512 * 1024;

export interface SearchServiceOptions {
    timeoutMs?: number;
    maxResults?: number;
    maxScannedFiles?: number;
}

type SearchParameters = RuntimeMethodParameters<'files.search'>;
type SearchResult = RuntimeMethodResult<'files.search'>;
interface SearchAccumulator {
    matches: FileSearchMatch[];
    bytes: number;
    full: boolean;
    scannedFiles: number;
    truncated: boolean;
}

function normalizedRelative(root: string, path: string): string {
    return relative(root, path).split(sep).join('/');
}

function escapeRegex(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Scans a single parenthesized group starting right after its opening `(` at `start`, returning the index just past its
 * matching `)` together with whether the group directly contains a quantifier. Kept as its own function (rather than
 * nested inside `hasNestedQuantifier`'s loop) so its scan stays a single, non-nested loop.
 */
function scanGroup(source: string, start: number): { end: number; hasQuantifier: boolean } {
    let depth = 1;
    let cursor = start;
    let hasQuantifier = false;
    while (cursor < source.length && depth > 0) {
        const character = source[cursor];
        if (character === '\\') {
            cursor += 2;
            continue;
        }
        if (character === '(') depth += 1;
        else if (character === ')') depth -= 1;
        else if (depth === 1 && ['+', '*', '{'].includes(character)) hasQuantifier = true;
        cursor += 1;
    }
    return { end: cursor, hasQuantifier };
}

/**
 * Detects the common catastrophic-backtracking shape `(…quantified…)quantifier`, e.g. `(a+)+`. Implemented as a manual
 * scan (rather than a single regex) because a regex expressive enough to find nested quantifiers is itself prone to the
 * same superlinear-backtracking pitfall it is meant to catch.
 */
function hasNestedQuantifier(source: string): boolean {
    for (let index = 0; index < source.length; index += 1) {
        if (source[index] === '\\') {
            index += 1;
            continue;
        }
        if (source[index] !== '(') continue;
        const { end, hasQuantifier } = scanGroup(source, index + 1);
        if (hasQuantifier && ['+', '*', '{'].includes(source[end])) return true;
    }
    return false;
}

function compileQuery(parameters: SearchParameters): RegExp {
    const source = parameters.regex ? parameters.query : escapeRegex(parameters.query);
    /**
     * Reject the common catastrophic nested-quantifier shape before running user regex on files.
     */
    if (parameters.regex && hasNestedQuantifier(source))
        throw new CaxriError('VALIDATION', 'Regular expression is too expensive to search safely');
    try {
        return new RegExp(
            parameters.wholeWord ? String.raw`\b(?:${source})\b` : source,
            parameters.caseSensitive ? 'g' : 'gi',
        );
    } catch {
        throw new CaxriError('VALIDATION', 'Invalid regular expression');
    }
}

function globRegex(pattern: string): RegExp {
    let source = '';
    for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index];
        if (character === '*' && pattern[index + 1] === '*') {
            source += '.*';
            index += 1;
        } else if (character === '*') source += '[^/]*';
        else if (character === '?') source += '[^/]';
        else source += escapeRegex(character);
    }
    return new RegExp(`^${source}$`);
}

function compileGlobs(source: string): Array<{ basenameOnly: boolean; regex: RegExp }> {
    return source
        .split(',')
        .map((pattern) => pattern.trim().replace(/^\.\//, ''))
        .filter(Boolean)
        .map((pattern) => ({ basenameOnly: !pattern.includes('/'), regex: globRegex(pattern) }));
}

function isMatchingGlobs(
    relativePath: string,
    patterns: Array<{ basenameOnly: boolean; regex: RegExp }>,
): boolean {
    return patterns.some(({ basenameOnly, regex }) =>
        regex.test(basenameOnly ? basename(relativePath) : relativePath),
    );
}

function previewLine(
    line: string,
    matchIndex: number,
): Pick<FileSearchMatch, 'preview' | 'previewMatchIndex'> {
    const start = Math.min(
        Math.max(0, matchIndex - Math.floor(MAX_PREVIEW_LENGTH / 3)),
        Math.max(0, line.length - MAX_PREVIEW_LENGTH),
    );
    return {
        preview: line.slice(start, start + MAX_PREVIEW_LENGTH),
        previewMatchIndex: matchIndex - start,
    };
}

/**
 * Bounded, Session-rooted Project search with latest-request cancellation per Session.
 */
export class SearchService {
    private readonly active = new Map<string, AbortController>();
    private readonly timeoutMs: number;
    private readonly maxResults: number;
    private readonly maxScannedFiles: number;

    constructor(
        private readonly resolveSessionPath: ResolveSessionPath,
        private readonly readDocument: (
            sessionId: string,
            path: string,
            signal?: AbortSignal,
        ) => Promise<FileDocument>,
        private readonly logger: StructuredLogger,
        private readonly maxFileBytes: () => number,
        options: SearchServiceOptions = {},
    ) {
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
        this.maxScannedFiles = options.maxScannedFiles ?? DEFAULT_MAX_SCANNED_FILES;
    }

    private async run(
        parameters: SearchParameters,
        signal: AbortSignal,
        startedAt: number,
    ): Promise<SearchResult> {
        const { root } = await this.resolveSessionPath(parameters.sessionId);
        const rootBefore = await lstat(root);
        if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink())
            throw new CaxriError('IO', 'Project root is not a directory');
        const include = compileGlobs(parameters.include);
        const exclude = compileGlobs(parameters.exclude);
        const query = compileQuery(parameters);
        const accumulator: SearchAccumulator = {
            matches: [],
            bytes: 0,
            full: false,
            scannedFiles: 0,
            truncated: false,
        };
        const directories = [root];

        /**
         * `directories` is a shared work stack and `accumulator` (scanned-file count, byte budget, fullness) is a
         * shared accumulator that each directory's scan checks and updates; walking concurrently would let scanning
         * race past the scanned-file/result-size limits before any single check could observe them, so the tree walk
         * stays sequential.
         */
        while (directories.length > 0 && !signal.aborted) {
            if (performance.now() - startedAt > this.timeoutMs) {
                accumulator.truncated = true;
                break;
            }
            const directory = directories.pop()!;
            // eslint-disable-next-line no-await-in-loop -- see comment above the loop
            const before = await lstat(directory);
            if (!before.isDirectory() || before.isSymbolicLink()) continue;
            let entries: Dirent[];
            try {
                // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                entries = await readdir(directory, { withFileTypes: true });
            } catch (error) {
                this.logSkipped(directory, error);
                continue;
            }
            // eslint-disable-next-line no-await-in-loop -- see comment above the loop
            const after = await lstat(directory);
            if (
                !after.isDirectory() ||
                after.isSymbolicLink() ||
                before.dev !== after.dev ||
                before.ino !== after.ino ||
                // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                (await realpath(directory)) !== directory
            )
                throw new CaxriError('IO', 'Directory changed during search');

            // eslint-disable-next-line no-await-in-loop -- see comment above the loop
            await this.scanDirectoryEntries(
                parameters,
                root,
                directory,
                entries,
                include,
                exclude,
                query,
                directories,
                accumulator,
                signal,
                startedAt,
            );
            if (accumulator.truncated) break;
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
        const isCanceled = signal.aborted;
        const sortedMatches = accumulator.matches.toSorted(
            (left, right) =>
                left.relativePath.localeCompare(right.relativePath) ||
                (left.line ?? 0) - (right.line ?? 0) ||
                (left.column ?? 0) - (right.column ?? 0),
        );
        const result: SearchResult = {
            mode: parameters.mode,
            matches: isCanceled ? [] : sortedMatches,
            scannedFiles: accumulator.scannedFiles,
            truncated: isCanceled ? false : accumulator.truncated,
            canceled: isCanceled,
        };
        this.logger.write('info', logEventCatalog.file.search, {
            durationMs: performance.now() - startedAt,
            fields: {
                sessionId: parameters.sessionId,
                mode: parameters.mode,
                scannedFiles: accumulator.scannedFiles,
                matchCount: result.matches.length,
                truncated: result.truncated,
                canceled: isCanceled,
            },
        });
        return result;
    }

    /**
     * Scans one already-listed directory's entries, pushing subdirectories onto the shared work stack and files into
     * the shared accumulator. Kept as the sole loop in this method (rather than nested inside `run`'s directory-walk
     * loop) so its early `break`/`continue` control flow stays scoped to a single loop.
     */
    private async scanDirectoryEntries(
        parameters: SearchParameters,
        root: string,
        directory: string,
        entries: readonly Dirent[],
        include: Array<{ basenameOnly: boolean; regex: RegExp }>,
        exclude: Array<{ basenameOnly: boolean; regex: RegExp }>,
        query: RegExp,
        directories: string[],
        accumulator: SearchAccumulator,
        signal: AbortSignal,
        startedAt: number,
    ): Promise<void> {
        for (const entry of entries) {
            if (signal.aborted) break;
            if (performance.now() - startedAt > this.timeoutMs) {
                accumulator.truncated = true;
                break;
            }
            if (isTraversalExcludedName(entry.name)) continue;
            const path = join(directory, entry.name);
            const relativePath = normalizedRelative(root, path);
            if (isMatchingGlobs(relativePath, exclude)) continue;
            let stats: Awaited<ReturnType<typeof lstat>>;
            try {
                // eslint-disable-next-line no-await-in-loop -- see `run`'s loop comment above
                stats = await lstat(path);
            } catch (error) {
                this.logSkipped(path, error);
                continue;
            }
            if (stats.isSymbolicLink()) continue;
            if (stats.isDirectory()) {
                directories.push(path);
                continue;
            }
            if (!stats.isFile() || stats.nlink > 1) continue;
            if (accumulator.scannedFiles >= this.maxScannedFiles) {
                accumulator.truncated = true;
                break;
            }
            accumulator.scannedFiles += 1;
            if (include.length > 0 && !isMatchingGlobs(relativePath, include)) continue;
            if (parameters.mode === 'name') {
                query.lastIndex = 0;
                if (query.test(relativePath)) this.appendMatch(accumulator, { path, relativePath });
            } else if (stats.size <= this.maxFileBytes()) {
                // eslint-disable-next-line no-await-in-loop -- see `run`'s loop comment above
                await this.searchDocument(
                    parameters,
                    path,
                    relativePath,
                    query,
                    accumulator,
                    signal,
                );
            }
            if (accumulator.full) {
                accumulator.truncated = true;
                break;
            }
        }
    }

    private async searchDocument(
        parameters: SearchParameters,
        path: string,
        relativePath: string,
        query: RegExp,
        accumulator: SearchAccumulator,
        signal: AbortSignal,
    ): Promise<void> {
        if (signal.aborted) return;
        let document: FileDocument;
        try {
            document = await this.readDocument(parameters.sessionId, path, signal);
        } catch (error) {
            this.logSkipped(path, error);
            return;
        }
        const lines = document.content.split(/\r?\n/);
        for (let index = 0; index < lines.length && !accumulator.full; index += 1)
            this.appendLineMatches(path, relativePath, lines[index], index, query, accumulator);
    }

    /**
     * Appends every match on a single line. Kept as its own method (rather than nested inside `searchDocument`'s
     * per-line loop) so its early `break` on a fully-consumed accumulator or an empty match stays scoped to a single
     * loop.
     */
    private appendLineMatches(
        path: string,
        relativePath: string,
        line: string,
        lineIndex: number,
        query: RegExp,
        accumulator: SearchAccumulator,
    ): void {
        query.lastIndex = 0;
        const matches = line.matchAll(query);
        for (const match of matches) {
            // `RegExpExecArray['index']` is always present for a `matchAll` result.
            const matchIndex = match.index;
            this.appendMatch(accumulator, {
                path,
                relativePath,
                line: lineIndex + 1,
                column: matchIndex + 1,
                matchLength: match[0].length,
                ...previewLine(line, matchIndex),
            });
            if (accumulator.full || match[0].length === 0) break;
        }
    }

    private appendMatch(accumulator: SearchAccumulator, match: FileSearchMatch): void {
        const bytes =
            Buffer.byteLength(match.path, 'utf8') +
            Buffer.byteLength(match.relativePath, 'utf8') +
            Buffer.byteLength(match.preview ?? '', 'utf8') +
            64;
        if (
            accumulator.matches.length >= this.maxResults ||
            accumulator.bytes + bytes > MAX_RESULT_PAYLOAD_BYTES
        ) {
            accumulator.full = true;
            return;
        }
        accumulator.matches.push(match);
        accumulator.bytes += bytes;
        if (accumulator.matches.length >= this.maxResults) accumulator.full = true;
    }

    private logSkipped(path: string, error: unknown): void {
        this.logger.write('debug', logEventCatalog.file.searchEntrySkipped, {
            fields: { path, error: errorMessage(error, 'unknown') },
        });
    }

    async search(
        parameters: SearchParameters,
        externalSignal?: AbortSignal,
    ): Promise<SearchResult> {
        this.active.get(parameters.sessionId)?.abort();
        const controller = new AbortController();
        this.active.set(parameters.sessionId, controller);
        const cancel = (): void => controller.abort();
        if (externalSignal?.aborted) controller.abort();
        externalSignal?.addEventListener('abort', cancel, { once: true });
        const startedAt = performance.now();
        try {
            return await this.run(parameters, controller.signal, startedAt);
        } finally {
            externalSignal?.removeEventListener('abort', cancel);
            if (this.active.get(parameters.sessionId) === controller)
                this.active.delete(parameters.sessionId);
        }
    }
}
