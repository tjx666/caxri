import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import { CaxriError, errorMessage } from '../../shared/ipc/errors';
import type { RuntimeMethodParams, RuntimeMethodResult } from '../../shared/ipc/methods';
import type { StructuredLogger } from '../../shared/node/logger';
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

type SearchParams = RuntimeMethodParams<'files.search'>;
type SearchResult = RuntimeMethodResult<'files.search'>;
interface SearchAccumulator {
    matches: FileSearchMatch[];
    bytes: number;
    full: boolean;
}

function normalizedRelative(root: string, path: string): string {
    return relative(root, path).split(sep).join('/');
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileQuery(params: SearchParams): RegExp {
    const source = params.regex ? params.query : escapeRegex(params.query);
    /** Reject the common catastrophic nested-quantifier shape before running user regex on files. */
    if (
        params.regex &&
        /\((?:\\.|[^()])*(?:[+*]|\{\d+(?:,\d*)?\})(?:\\.|[^()])*\)(?:[+*]|\{\d+(?:,\d*)?\})/.test(
            source,
        )
    )
        throw new CaxriError('VALIDATION', 'Regular expression is too expensive to search safely');
    try {
        return new RegExp(
            params.wholeWord ? `\\b(?:${source})\\b` : source,
            params.caseSensitive ? 'g' : 'gi',
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

function matchesGlobs(
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

/** Bounded, Session-rooted Project search with latest-request cancellation per Session. */
export class SearchService {
    private readonly active = new Map<string, AbortController>();
    private readonly timeoutMs: number;
    private readonly maxResults: number;
    private readonly maxScannedFiles: number;

    constructor(
        private readonly resolveSessionPath: ResolveSessionPath,
        private readonly readDocument: (sessionId: string, path: string) => Promise<FileDocument>,
        private readonly logger: StructuredLogger,
        private readonly maxFileBytes: () => number,
        options: SearchServiceOptions = {},
    ) {
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
        this.maxScannedFiles = options.maxScannedFiles ?? DEFAULT_MAX_SCANNED_FILES;
    }

    async search(params: SearchParams): Promise<SearchResult> {
        this.active.get(params.sessionId)?.abort();
        const controller = new AbortController();
        this.active.set(params.sessionId, controller);
        const startedAt = performance.now();
        try {
            return await this.run(params, controller.signal, startedAt);
        } finally {
            if (this.active.get(params.sessionId) === controller)
                this.active.delete(params.sessionId);
        }
    }

    private async run(
        params: SearchParams,
        signal: AbortSignal,
        startedAt: number,
    ): Promise<SearchResult> {
        const { root } = await this.resolveSessionPath(params.sessionId);
        const rootBefore = await lstat(root);
        if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink())
            throw new CaxriError('IO', 'Project root is not a directory');
        const include = compileGlobs(params.include);
        const exclude = compileGlobs(params.exclude);
        const query = compileQuery(params);
        const accumulator: SearchAccumulator = { matches: [], bytes: 0, full: false };
        let scannedFiles = 0;
        let truncated = false;
        const directories = [root];

        while (directories.length > 0 && !signal.aborted) {
            if (performance.now() - startedAt > this.timeoutMs) {
                truncated = true;
                break;
            }
            const directory = directories.pop()!;
            const before = await lstat(directory);
            if (!before.isDirectory() || before.isSymbolicLink()) continue;
            let entries: Dirent[];
            try {
                entries = await readdir(directory, { withFileTypes: true });
            } catch (error) {
                this.logSkipped(directory, error);
                continue;
            }
            const after = await lstat(directory);
            if (
                !after.isDirectory() ||
                after.isSymbolicLink() ||
                before.dev !== after.dev ||
                before.ino !== after.ino ||
                (await realpath(directory)) !== directory
            )
                throw new CaxriError('IO', 'Directory changed during search');

            for (const entry of entries) {
                if (signal.aborted) break;
                if (performance.now() - startedAt > this.timeoutMs) {
                    truncated = true;
                    break;
                }
                if (isTraversalExcludedName(entry.name)) continue;
                const path = join(directory, entry.name);
                const relativePath = normalizedRelative(root, path);
                if (matchesGlobs(relativePath, exclude)) continue;
                let stats: Awaited<ReturnType<typeof lstat>>;
                try {
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
                if (scannedFiles >= this.maxScannedFiles) {
                    truncated = true;
                    break;
                }
                scannedFiles += 1;
                if (include.length > 0 && !matchesGlobs(relativePath, include)) continue;
                if (params.mode === 'name') {
                    query.lastIndex = 0;
                    if (query.test(relativePath))
                        this.appendMatch(accumulator, { path, relativePath });
                } else if (stats.size <= this.maxFileBytes()) {
                    await this.searchDocument(params, path, relativePath, query, accumulator);
                }
                if (accumulator.full) {
                    truncated = true;
                    break;
                }
            }
            if (truncated) break;
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
        accumulator.matches.sort(
            (left, right) =>
                left.relativePath.localeCompare(right.relativePath) ||
                (left.line ?? 0) - (right.line ?? 0) ||
                (left.column ?? 0) - (right.column ?? 0),
        );
        const result: SearchResult = {
            mode: params.mode,
            matches: canceled ? [] : accumulator.matches,
            scannedFiles,
            truncated: canceled ? false : truncated,
            canceled,
        };
        this.logger.write('info', 'file.search', {
            durationMs: performance.now() - startedAt,
            fields: {
                sessionId: params.sessionId,
                mode: params.mode,
                scannedFiles,
                matchCount: result.matches.length,
                truncated: result.truncated,
                canceled,
            },
        });
        return result;
    }

    private async searchDocument(
        params: SearchParams,
        path: string,
        relativePath: string,
        query: RegExp,
        accumulator: SearchAccumulator,
    ): Promise<void> {
        let document: FileDocument;
        try {
            document = await this.readDocument(params.sessionId, path);
        } catch (error) {
            this.logSkipped(path, error);
            return;
        }
        const lines = document.content.split(/\r?\n/);
        for (let index = 0; index < lines.length && !accumulator.full; index += 1) {
            query.lastIndex = 0;
            for (const match of lines[index].matchAll(query)) {
                const matchIndex = match.index ?? 0;
                this.appendMatch(accumulator, {
                    path,
                    relativePath,
                    line: index + 1,
                    column: matchIndex + 1,
                    matchLength: match[0].length,
                    ...previewLine(lines[index], matchIndex),
                });
                if (accumulator.full || match[0].length === 0) break;
            }
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
        this.logger.write('debug', 'file.search_entry_skipped', {
            fields: { path, error: errorMessage(error, 'unknown') },
        });
    }
}
