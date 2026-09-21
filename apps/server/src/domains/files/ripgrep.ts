import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { sep } from 'node:path';
import { Worker } from 'node:worker_threads';

import type {
    FileSearchMatch,
    FileSearchTerminationReason,
    ServerOperationParameters,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import {
    PROJECT_TRAVERSAL_EXCLUDED_SEGMENTS,
    PROJECT_TRAVERSAL_EXCLUDED_SUFFIXES,
} from './ignore-rules';
import type { ProjectSearchWorkerInput, ProjectSearchWorkerMessage } from './project-search-worker';

const MAX_ENUMERATION_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_RELATIVE_PATH_BYTES = 16_384;
const MAX_RESULT_PAYLOAD_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const FORCE_KILL_DELAY_MS = 250;

type SearchParameters = ServerOperationParameters<'files.search'>;

export interface RipgrepSearchOptions {
    executablePath: string;
    maxFileBytes: number;
    maxResults: number;
    maxScannedFiles: number;
    timeoutMs: number;
    workerPath: string;
}

export interface RipgrepSearchExecution {
    matches: FileSearchMatch[];
    scannedFiles: number;
    terminationReason: FileSearchTerminationReason;
}

interface EnumerationResult {
    paths: string[];
    terminationReason: 'completed' | 'canceled' | 'file-limit' | 'timeout';
}

function normalizedRipgrepPath(path: string): string {
    const withoutDotPrefix = path.startsWith(`.${sep}`) ? path.slice(2) : path;
    return sep === '/' ? withoutDotPrefix : withoutDotPrefix.replaceAll(sep, '/');
}

function escapedRipgrepGlobSegment(segment: string): string | undefined {
    let result = '';
    for (let index = 0; index < segment.length; index += 1) {
        const character = segment[index];
        if (character === '*') {
            let end = index + 1;
            while (segment[end] === '*') end += 1;
            if (end - index > 1) return;
            result += '*';
            index = end - 1;
        } else if (character === '?') result += character;
        else if ('![]{}\\'.includes(character)) result += `\\${character}`;
        else result += character;
    }
    return result;
}

/**
 * Pushes down only excludes that ripgrep can represent without dropping a path the legacy matcher would keep. globset
 * lets a recursive glob consume zero directories, while Caxri's established slash-separated semantics require one or
 * more, so a non-terminal recursive segment gains one required component. Embedded multi-star runs stay Worker-only.
 */
function ripgrepExcludeGlob(pattern: string): string | undefined {
    if (
        pattern.length === 0 ||
        pattern.includes('\0') ||
        pattern.startsWith('/') ||
        pattern.endsWith('/') ||
        pattern.includes('//')
    )
        return;
    const segments = pattern.split('/');
    const translated: string[] = [];
    for (const [index, segment] of segments.entries()) {
        if (/^\*{2,}$/u.test(segment)) {
            if (segments.length === 1 || index === segments.length - 1) translated.push('**');
            else translated.push('?*', '**');
            continue;
        }
        const escaped = escapedRipgrepGlobSegment(segment);
        if (!escaped) return;
        translated.push(escaped);
    }
    return translated.join('/');
}

function userExcludeGlobArguments(source: string): string[] {
    return source
        .split(',')
        .map((pattern) => pattern.trim().replace(/^\.\//u, ''))
        .flatMap((pattern) => {
            const translated = ripgrepExcludeGlob(pattern);
            return translated ? ['--glob', `!${translated}`] : [];
        });
}

/**
 * How the Project's own ignore files enter the enumeration.
 *
 * `--no-ignore-parent` and `--no-ignore-global` keep the answer a property of this Project alone: a scan must not
 * change because of a checkout above the Project root or a `core.excludesFile` in the operator's home directory, and VS
 * Code withholds both by default for the same reason (`search.useParentIgnoreFiles`, `search.useGlobalIgnoreFiles`).
 * `--no-require-git` applies `.gitignore` in a directory that is not a repository, which is what a user who wrote one
 * expects and what a Project created from a plain folder would otherwise silently skip.
 *
 * `--hidden` stays on both paths: a dotfile is ordinary Project content, and `.git` is excluded by name below.
 */
const IGNORE_FILE_ARGUMENTS = ['--no-ignore-parent', '--no-ignore-global', '--no-require-git'];

function enumerationArguments(exclude: string, isUsingIgnoreFiles: boolean): string[] {
    const directoryGlobArguments = PROJECT_TRAVERSAL_EXCLUDED_SEGMENTS.flatMap((name) => [
        '--glob',
        `!${name}/**`,
        '--glob',
        `!**/${name}/**`,
    ]);
    const suffixGlobArguments = PROJECT_TRAVERSAL_EXCLUDED_SUFFIXES.flatMap((suffix) => [
        '--glob',
        `!*${suffix}`,
        '--glob',
        `!**/*${suffix}`,
    ]);
    return [
        '--files',
        '--hidden',
        ...(isUsingIgnoreFiles ? IGNORE_FILE_ARGUMENTS : ['--no-ignore']),
        '--no-config',
        '--no-messages',
        '--null',
        ...directoryGlobArguments,
        ...suffixGlobArguments,
        ...userExcludeGlobArguments(exclude),
    ];
}

function validateSearchQuery(parameters: SearchParameters): void {
    const source = parameters.regex
        ? parameters.query
        : parameters.query.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    new RegExp(
        parameters.wholeWord ? String.raw`\b(?:${source})\b` : source,
        parameters.caseSensitive ? 'g' : 'gi',
    );
}

function scheduleForceKill(child: ReturnType<typeof spawn>): NodeJS.Timeout {
    const timeout = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, FORCE_KILL_DELAY_MS);
    timeout.unref();
    return timeout;
}

async function enumerateProjectFiles(
    root: string,
    signal: AbortSignal,
    deadline: number,
    options: RipgrepSearchOptions,
    enumeration: Pick<SearchParameters, 'exclude' | 'useIgnoreFiles'>,
): Promise<EnumerationResult> {
    if (signal.aborted) return { paths: [], terminationReason: 'canceled' };
    if (performance.now() >= deadline) return { paths: [], terminationReason: 'timeout' };

    return new Promise<EnumerationResult>((resolve, reject) => {
        const child = spawn(
            options.executablePath,
            enumerationArguments(enumeration.exclude, enumeration.useIgnoreFiles),
            {
                cwd: root,
                shell: false,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            },
        );
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const paths: string[] = [];
        let buffered = Buffer.alloc(0);
        let outputBytes = 0;
        let stderrBytes = 0;
        let forceKillTimer: NodeJS.Timeout | undefined;
        let isEngineFailed = false;
        let isSettled = false;
        let stopReason: EnumerationResult['terminationReason'] | undefined;
        const timeout = setTimeout(
            () => stop('timeout'),
            Math.max(0, deadline - performance.now()),
        );
        timeout.unref();

        function cleanup(): void {
            clearTimeout(timeout);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            signal.removeEventListener('abort', cancel);
        }
        function stop(reason: EnumerationResult['terminationReason']): void {
            if (isSettled || stopReason) return;
            stopReason = reason;
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGTERM');
                forceKillTimer = scheduleForceKill(child);
            }
        }
        function cancel(): void {
            stop('canceled');
        }
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) stop('canceled');

        child.stdout.on('data', (chunk: Buffer) => {
            if (stopReason) return;
            outputBytes += chunk.length;
            if (outputBytes > MAX_ENUMERATION_OUTPUT_BYTES) {
                stop('file-limit');
                return;
            }
            buffered = Buffer.concat([buffered, chunk]);
            let separatorIndex = buffered.indexOf(0);
            while (separatorIndex >= 0) {
                const encodedPath = buffered.subarray(0, separatorIndex);
                buffered = buffered.subarray(separatorIndex + 1);
                if (encodedPath.length > 0 && encodedPath.length <= MAX_RELATIVE_PATH_BYTES) {
                    try {
                        paths.push(normalizedRipgrepPath(decoder.decode(encodedPath)));
                    } catch {
                        isEngineFailed = true;
                        stop('file-limit');
                        return;
                    }
                }
                if (paths.length > options.maxScannedFiles) {
                    paths.length = options.maxScannedFiles;
                    stop('file-limit');
                    return;
                }
                separatorIndex = buffered.indexOf(0);
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes > MAX_STDERR_BYTES) stop('file-limit');
        });
        child.once('error', () => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            reject(new CaxriError('UNAVAILABLE', 'Project search engine is unavailable'));
        });
        child.once('close', (code) => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            if (isEngineFailed) {
                reject(new CaxriError('IO', 'Project file enumeration failed'));
                return;
            }
            if (stopReason) {
                resolve({ paths, terminationReason: stopReason });
                return;
            }
            /**
             * Ripgrep uses exit code 2 when individual entries cannot be traversed, while still returning every
             * accessible path. The previous secure walker skipped the same per-entry failures, so preserve that
             * behavior; fixed arguments, stderr/output caps, and the post-search root check cover engine failures.
             */
            if (code !== 0 && code !== 1 && code !== 2) {
                reject(new CaxriError('IO', 'Project file enumeration failed'));
                return;
            }
            if (buffered.length > 0) {
                reject(new CaxriError('IO', 'Project file enumeration returned invalid output'));
                return;
            }
            resolve({ paths, terminationReason: 'completed' });
        });
    });
}

async function runWorker(
    input: ProjectSearchWorkerInput,
    signal: AbortSignal,
    deadline: number,
    workerPath: string,
): Promise<RipgrepSearchExecution> {
    if (signal.aborted) return { matches: [], scannedFiles: 0, terminationReason: 'canceled' };
    if (performance.now() >= deadline)
        return { matches: [], scannedFiles: 0, terminationReason: 'timeout' };

    return new Promise<RipgrepSearchExecution>((resolve, reject) => {
        const worker = new Worker(workerPath, { workerData: input });
        const matches: FileSearchMatch[] = [];
        let scannedFiles = 0;
        let isSettled = false;
        const timeout = setTimeout(
            () => stop('timeout'),
            Math.max(0, deadline - performance.now()),
        );
        timeout.unref();

        function cleanup(): void {
            clearTimeout(timeout);
            signal.removeEventListener('abort', cancel);
            worker.removeAllListeners();
        }
        function finish(result: RipgrepSearchExecution): void {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            // eslint-disable-next-line unicorn/prefer-await, unicorn/prefer-then-catch -- settle only after Worker exit
            worker.terminate().then(() => resolve(result), reject);
        }
        function fail(error: unknown): void {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            const controlledError =
                error instanceof Error ? error : new Error('Project search worker failed');
            // eslint-disable-next-line promise/no-promise-in-callback, unicorn/prefer-await, unicorn/prefer-then-catch -- preserve the controlled error after Worker exit
            worker.terminate().then(
                () => reject(controlledError),
                () => reject(controlledError),
            );
        }
        function stop(reason: 'canceled' | 'timeout'): void {
            finish({
                matches: reason === 'canceled' ? [] : matches,
                scannedFiles,
                terminationReason: reason,
            });
        }
        function cancel(): void {
            stop('canceled');
        }
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) stop('canceled');

        worker.on('message', (message: ProjectSearchWorkerMessage) => {
            if (isSettled) return;
            if (message.type === 'error') {
                fail(new CaxriError(message.code, message.message));
                return;
            }
            matches.push(...message.matches);
            scannedFiles = message.scannedFiles;
            if (message.type === 'complete')
                finish({
                    matches,
                    scannedFiles,
                    terminationReason: message.terminationReason,
                });
        });
        worker.once('error', () => {
            fail(new CaxriError('IO', 'Project search worker failed'));
        });
        worker.once('exit', (code) => {
            if (!isSettled)
                fail(
                    new CaxriError(
                        'IO',
                        code === 0
                            ? 'Project search worker exited without a result'
                            : 'Project search worker exited unexpectedly',
                    ),
                );
        });
    });
}

/**
 * Uses bundled ripgrep only for fast, configuration-independent file discovery. File contents remain behind an isolated
 * worker that revalidates every path and file handle before reading, preserving the Project boundary while making even
 * a pathological JavaScript regular expression terminable.
 */
export async function runRipgrepSearch(
    root: string,
    parameters: SearchParameters,
    signal: AbortSignal,
    startedAt: number,
    options: RipgrepSearchOptions,
): Promise<RipgrepSearchExecution> {
    const deadline = startedAt + options.timeoutMs;
    try {
        /**
         * Fail fast before enumerating a large Project; the isolated Worker compiles again before matching.
         */
        validateSearchQuery(parameters);
    } catch {
        throw new CaxriError('VALIDATION', 'Invalid regular expression');
    }
    const enumeration = await enumerateProjectFiles(root, signal, deadline, options, parameters);
    if (enumeration.terminationReason === 'canceled')
        return { matches: [], scannedFiles: 0, terminationReason: 'canceled' };
    if (enumeration.terminationReason === 'timeout')
        return {
            matches: [],
            scannedFiles: enumeration.paths.length,
            terminationReason: 'timeout',
        };

    const workerResult = await runWorker(
        {
            maxFileBytes: options.maxFileBytes,
            maxPayloadBytes: MAX_RESULT_PAYLOAD_BYTES,
            maxResults: options.maxResults,
            parameters,
            paths: enumeration.paths.toSorted((left, right) => left.localeCompare(right)),
            root,
        },
        signal,
        deadline,
        options.workerPath,
    );
    if (
        workerResult.terminationReason === 'completed' &&
        enumeration.terminationReason === 'file-limit'
    )
        return { ...workerResult, terminationReason: 'file-limit' };
    return workerResult;
}
