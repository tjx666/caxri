import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import type { FileSearchMatch, FileSearchMode, FileSearchTerminationReason } from '@caxri/protocol';

const MAX_PREVIEW_LENGTH = 300;
const MAX_IN_FLIGHT_CONTENT_BYTES = 64 * 1024 * 1024;
const PROGRESS_INTERVAL = 128;
const MAX_READ_CONCURRENCY = 32;

interface ProjectSearchWorkerParameters {
    caseSensitive: boolean;
    exclude: string;
    include: string;
    mode: FileSearchMode;
    query: string;
    regex: boolean;
    wholeWord: boolean;
}

export interface ProjectSearchWorkerInput {
    maxFileBytes: number;
    maxPayloadBytes: number;
    maxResults: number;
    parameters: ProjectSearchWorkerParameters;
    paths: string[];
    root: string;
}

export interface ProjectSearchWorkerProgress {
    matches: FileSearchMatch[];
    scannedFiles: number;
}

export type ProjectSearchWorkerMessage =
    | ({
          type: 'complete';
          terminationReason: FileSearchTerminationReason;
      } & ProjectSearchWorkerProgress)
    | ({ type: 'progress' } & ProjectSearchWorkerProgress)
    | { type: 'error'; code: 'IO' | 'VALIDATION'; message: string };

interface SearchAccumulator {
    bytes: number;
    matches: FileSearchMatch[];
    pendingMatches: FileSearchMatch[];
    scannedFiles: number;
    terminationReason?: 'payload-limit' | 'result-limit';
}

interface PreparedCandidate {
    candidate: { content: string; path: string } | { path: string; size: number } | undefined;
    eligible: boolean;
    relativePath: string;
}

class WorkerSearchError extends Error {
    readonly code: 'IO' | 'VALIDATION';

    constructor(code: 'IO' | 'VALIDATION', message: string) {
        super(message);
        this.code = code;
    }
}

function escapeRegex(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function compileQuery(parameters: ProjectSearchWorkerParameters): RegExp {
    const source = parameters.regex ? parameters.query : escapeRegex(parameters.query);
    try {
        return new RegExp(
            parameters.wholeWord ? String.raw`\b(?:${source})\b` : source,
            parameters.caseSensitive ? 'g' : 'gi',
        );
    } catch {
        throw new WorkerSearchError('VALIDATION', 'Invalid regular expression');
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
        .map((pattern) => pattern.trim().replace(/^\.\//u, ''))
        .filter(Boolean)
        .map((pattern) => ({ basenameOnly: !pattern.includes('/'), regex: globRegex(pattern) }));
}

function isMatchingGlobs(
    relativePath: string,
    patterns: Array<{ basenameOnly: boolean; regex: RegExp }>,
): boolean {
    const basename = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    return patterns.some(({ basenameOnly, regex }) =>
        regex.test(basenameOnly ? basename : relativePath),
    );
}

function contentReadConcurrency(maxFileBytes: number): number {
    const byteBounded = Math.floor(MAX_IN_FLIGHT_CONTENT_BYTES / Math.max(1, maxFileBytes));
    return Math.max(1, Math.min(MAX_READ_CONCURRENCY, byteBounded));
}

function normalizedRelative(root: string, path: string): string {
    return relative(root, path).split(sep).join('/');
}

function absoluteCandidate(root: string, relativePath: string): string | undefined {
    if (!relativePath || isAbsolute(relativePath)) return;
    const candidate = resolve(root, relativePath.split('/').join(sep));
    if (normalizedRelative(root, candidate) !== relativePath) return;
    return candidate;
}

async function validateCandidate(
    root: string,
    relativePath: string,
): Promise<{ path: string; size: number } | undefined> {
    const path = absoluteCandidate(root, relativePath);
    if (!path) return;
    try {
        const stats = await lstat(path);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink > 1) return;
        if ((await realpath(path)) !== path) return;
        return { path, size: stats.size };
    } catch {
        return;
    }
}

async function readCandidate(
    root: string,
    relativePath: string,
    maxFileBytes: number,
): Promise<{ content: string; path: string } | undefined> {
    const path = absoluteCandidate(root, relativePath);
    if (!path) return;
    try {
        const before = await lstat(path);
        if (
            !before.isFile() ||
            before.isSymbolicLink() ||
            before.nlink > 1 ||
            before.size > maxFileBytes
        )
            return;
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            if ((await realpath(path)) !== path) return;
            const opened = await file.stat();
            if (
                !opened.isFile() ||
                opened.dev !== before.dev ||
                opened.ino !== before.ino ||
                opened.nlink > 1 ||
                opened.size > maxFileBytes
            )
                return;
            const buffer = await readBoundedFile(file, opened.size, maxFileBytes);
            if (!buffer) return;
            if (buffer.subarray(0, 8_192).includes(0)) return;
            return { content: buffer.toString('utf8'), path };
        } finally {
            await file.close();
        }
    } catch {
        return;
    }
}

/**
 * Reads at most one byte beyond the configured limit. A repository process may grow a file after `fstat`; using
 * `readFile` here would let that race allocate beyond the search budget before the Worker could reject it. The buffer
 * starts at the `fstat` size rather than the cap: a cap-sized Buffer per file kept this Worker in back-to-back full
 * GCs. Same loop as `readFileHandleUpTo` in `../bounded-file-reader.ts`; this Worker imports only Node builtins at
 * runtime because its tests run this source directly as a Worker.
 */
async function readBoundedFile(
    file: FileHandle,
    sizeHint: number,
    maxFileBytes: number,
): Promise<Buffer | undefined> {
    let buffer = Buffer.allocUnsafe(Math.min(sizeHint, maxFileBytes) + 1);
    let offset = 0;
    for (;;) {
        if (offset === buffer.length) {
            if (buffer.length > maxFileBytes) return;
            const grown = Buffer.allocUnsafe(maxFileBytes + 1);
            buffer.copy(grown, 0, 0, offset);
            buffer = grown;
        }
        // eslint-disable-next-line no-await-in-loop -- partial reads must fill one bounded buffer before decoding
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
    }
    return buffer.subarray(0, offset);
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

function appendMatch(
    accumulator: SearchAccumulator,
    match: FileSearchMatch,
    maxResults: number,
    maxPayloadBytes: number,
): void {
    if (accumulator.matches.length >= maxResults) {
        accumulator.terminationReason = 'result-limit';
        return;
    }
    const bytes =
        Buffer.byteLength(match.path, 'utf8') +
        Buffer.byteLength(match.relativePath, 'utf8') +
        Buffer.byteLength(match.preview ?? '', 'utf8') +
        64;
    if (accumulator.bytes + bytes > maxPayloadBytes) {
        accumulator.terminationReason = 'payload-limit';
        return;
    }
    accumulator.matches.push(match);
    accumulator.pendingMatches.push(match);
    accumulator.bytes += bytes;
    if (accumulator.matches.length >= maxResults) accumulator.terminationReason = 'result-limit';
}

function appendMatchesForLine(
    path: string,
    relativePath: string,
    line: string,
    lineIndex: number,
    query: RegExp,
    accumulator: SearchAccumulator,
    input: ProjectSearchWorkerInput,
): void {
    query.lastIndex = 0;
    for (const match of line.matchAll(query)) {
        const matchIndex = match.index;
        appendMatch(
            accumulator,
            {
                path,
                relativePath,
                line: lineIndex + 1,
                column: matchIndex + 1,
                matchLength: Math.min(match[0].length, 1_024),
                ...previewLine(line, matchIndex),
            },
            input.maxResults,
            input.maxPayloadBytes,
        );
        if (accumulator.terminationReason || match[0].length === 0) return;
    }
}

function appendLineMatches(
    path: string,
    relativePath: string,
    content: string,
    query: RegExp,
    accumulator: SearchAccumulator,
    input: ProjectSearchWorkerInput,
): void {
    const lines = content.split(/\r?\n/u);
    for (
        let lineIndex = 0;
        lineIndex < lines.length && !accumulator.terminationReason;
        lineIndex += 1
    )
        appendMatchesForLine(
            path,
            relativePath,
            lines[lineIndex],
            lineIndex,
            query,
            accumulator,
            input,
        );
}

function post(message: ProjectSearchWorkerMessage): void {
    parentPort?.postMessage(message);
}

function flushProgress(
    accumulator: SearchAccumulator,
    type: 'complete' | 'progress',
    terminationReason?: FileSearchTerminationReason,
): void {
    const progress = {
        matches: [...accumulator.pendingMatches],
        scannedFiles: accumulator.scannedFiles,
    };
    accumulator.pendingMatches.length = 0;
    if (type === 'complete') {
        post({ type, terminationReason: terminationReason ?? 'completed', ...progress });
        return;
    }
    post({ type, ...progress });
}

async function assertStableRoot(
    root: string,
    before: Awaited<ReturnType<typeof lstat>>,
): Promise<void> {
    const after = await lstat(root);
    if (
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        (await realpath(root)) !== root
    )
        throw new WorkerSearchError('IO', 'Project root changed during search');
}

function processCandidateBatch(
    candidates: PreparedCandidate[],
    query: RegExp,
    accumulator: SearchAccumulator,
    input: ProjectSearchWorkerInput,
): void {
    for (const { candidate, eligible, relativePath } of candidates) {
        if (!candidate) continue;
        accumulator.scannedFiles += 1;
        if (!eligible) continue;

        if (input.parameters.mode === 'name') {
            query.lastIndex = 0;
            if (query.test(relativePath))
                appendMatch(
                    accumulator,
                    { path: candidate.path, relativePath },
                    input.maxResults,
                    input.maxPayloadBytes,
                );
        } else if ('content' in candidate) {
            appendLineMatches(
                candidate.path,
                relativePath,
                candidate.content,
                query,
                accumulator,
                input,
            );
        }

        if (accumulator.terminationReason) return;
        if (
            accumulator.pendingMatches.length > 0 ||
            accumulator.scannedFiles % PROGRESS_INTERVAL === 0
        )
            flushProgress(accumulator, 'progress');
    }
}

async function run(input: ProjectSearchWorkerInput): Promise<void> {
    const rootBefore = await lstat(input.root);
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink())
        throw new WorkerSearchError('IO', 'Project root is not a directory');
    const include = compileGlobs(input.parameters.include);
    const exclude = compileGlobs(input.parameters.exclude);
    const query = compileQuery(input.parameters);
    const accumulator: SearchAccumulator = {
        bytes: 0,
        matches: [],
        pendingMatches: [],
        scannedFiles: 0,
    };
    const readConcurrency =
        input.parameters.mode === 'content'
            ? contentReadConcurrency(input.maxFileBytes)
            : MAX_READ_CONCURRENCY;

    for (
        let offset = 0;
        offset < input.paths.length && !accumulator.terminationReason;
        offset += readConcurrency
    ) {
        // eslint-disable-next-line no-await-in-loop -- each byte-bounded batch must settle before opening the next files
        const candidates: PreparedCandidate[] = await Promise.all(
            input.paths.slice(offset, offset + readConcurrency).map(async (relativePath) => {
                const isMatchesInclude =
                    include.length === 0 || isMatchingGlobs(relativePath, include);
                const isEligible = !isMatchingGlobs(relativePath, exclude) && isMatchesInclude;
                return {
                    candidate:
                        isEligible && input.parameters.mode === 'content'
                            ? await readCandidate(input.root, relativePath, input.maxFileBytes)
                            : await validateCandidate(input.root, relativePath),
                    eligible: isEligible,
                    relativePath,
                };
            }),
        );
        processCandidateBatch(candidates, query, accumulator, input);
    }

    await assertStableRoot(input.root, rootBefore);
    flushProgress(accumulator, 'complete', accumulator.terminationReason ?? 'completed');
}

try {
    await run(workerData as ProjectSearchWorkerInput);
} catch (error: unknown) {
    post({
        type: 'error',
        code: error instanceof WorkerSearchError ? error.code : 'IO',
        message: error instanceof Error ? error.message : 'Project search worker failed',
    });
}
