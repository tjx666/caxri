import { createHash } from 'node:crypto';

import type { AsyncSemaphore, StructuredLogger } from '@caxri/system';
import { execFileAsync, logEventCatalog } from '@caxri/system';

import { classifyGitFailure, gitFailureLogLevel, resolveGitLaunch, toGitError } from './errors';
import { gitSignalOptions } from './request-signal';

const MAX_GIT_METADATA_BYTES = 4 * 1024 * 1024;

export interface GitCommandOptions {
    allowFailure?: boolean;
    input?: string;
    maxBufferBytes?: number;
    /**
     * Override for network-bound operations (fetch/pull/push), which can legitimately outlast the 10s default that
     * bounds local metadata commands.
     */
    timeoutMs?: number;
}

/**
 * Subcommand-bearing Git operations whose second argv token is required to attribute a command in structured logs
 * (`worktree list` vs `worktree add`); every other operation logs argv[0] alone so no user-controlled path or ref ever
 * reaches the log stream.
 */
const SUBCOMMAND_OPERATIONS = new Set(['worktree', 'remote', 'stash', 'submodule']);

function classifyGitOperation(arguments_: readonly string[]): string {
    const operation = arguments_[0] ?? 'unknown';
    if (!SUBCOMMAND_OPERATIONS.has(operation)) return operation;
    const subcommand = arguments_.find((token, index) => index > 0 && !token.startsWith('-'));
    return subcommand ? `${operation}.${subcommand}` : operation;
}

/**
 * Stable, non-reversible identity for correlating commands of one repository in diagnostics without recording the
 * filesystem path itself.
 */
function hashRepoPath(path: string): string {
    return createHash('sha256').update(path).digest('hex').slice(0, 12);
}

/**
 * Content-free facts about a failed Git child for `git.command_failed`, read from the fault's structured properties and
 * never from its message: Node's promisified `execFile` formats that message as `Command failed: git <argv>` plus Git's
 * stderr, so it carries refs, `rev:path` specs, remote URLs, and repository paths. `errorCode` admits only an uppercase
 * constant (`EMFILE`, `ABORT_ERR`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`), which is what still separates a spawn fault or
 * a cancellation from Git's own non-zero exit once the message is gone.
 */
function gitFailureFields(error: unknown): {
    errorCode: string | null;
    exitCode: number | null;
    signal: string | null;
} {
    const fault =
        error !== null && typeof error === 'object'
            ? (error as { code?: unknown; signal?: unknown })
            : {};
    return {
        errorCode:
            typeof fault.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(fault.code)
                ? fault.code
                : null,
        exitCode:
            typeof fault.code === 'number' && Number.isSafeInteger(fault.code) ? fault.code : null,
        signal:
            typeof fault.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/u.test(fault.signal)
                ? fault.signal
                : null,
    };
}

/**
 * Runs one Git command under the shared concurrency budget with a non-interactive, locale-stable environment, and
 * records it as a `git.command` (or `git.commandFailed`) event that never carries a path or ref. A failure is explained
 * by the closed `GitFailureReason` plus the exit status from {@link gitFailureFields}, never by the fault message.
 */
export async function runGitCommand(
    commands: AsyncSemaphore,
    logger: StructuredLogger,
    cwd: string,
    arguments_: string[],
    options: GitCommandOptions = {},
): Promise<string> {
    const queuedAt = performance.now();
    return commands.run(async () => {
        const startedAt = performance.now();
        const timing = () => ({
            queueMs: startedAt - queuedAt,
            execMs: performance.now() - startedAt,
            repository: hashRepoPath(cwd),
        });
        try {
            const { executable, environment } = await resolveGitLaunch();
            const execution = execFileAsync(executable, arguments_, {
                cwd,
                timeout: options.timeoutMs ?? 10_000,
                maxBuffer: options.maxBufferBytes ?? MAX_GIT_METADATA_BYTES,
                ...gitSignalOptions(),
                // GIT_TERMINAL_PROMPT=0 makes a credential-less fetch/pull/push fail fast
                // instead of hanging on a hidden terminal prompt until the timeout.
                env: {
                    ...environment,
                    GIT_OPTIONAL_LOCKS: '0',
                    GIT_TERMINAL_PROMPT: '0',
                    LC_ALL: 'C',
                },
            });
            if (options.input !== undefined) {
                /**
                 * A fast Git failure may close stdin before the bounded batch is written.
                 */
                execution.child.stdin?.on('error', () => {});
                execution.child.stdin?.end(options.input);
            }
            const { stdout } = await execution;
            // Debug, not info: on a real profile `git.command` plus `git.summary` filled 87% of a 5MB generation
            // and cut retention to ~38h, rotating out the lifecycle evidence incidents need. Failures stay at warn.
            logger.write('debug', logEventCatalog.git.command, {
                durationMs: performance.now() - queuedAt,
                fields: { operation: classifyGitOperation(arguments_), ...timing() },
            });
            return stdout;
        } catch (error) {
            const reason = classifyGitFailure(error);
            const level = gitFailureLogLevel(reason, options.allowFailure);
            logger.write(level, logEventCatalog.git.commandFailed, {
                durationMs: performance.now() - queuedAt,
                fields: {
                    operation: classifyGitOperation(arguments_),
                    ...timing(),
                    allowFailure: options.allowFailure === true,
                    reason,
                    ...gitFailureFields(error),
                },
            });
            // A cancellation is not an answer: an empty result would let the abandoned request finish on fake output.
            if (reason !== 'cancelled' && options.allowFailure) return '';
            throw toGitError(error);
        }
    });
}
