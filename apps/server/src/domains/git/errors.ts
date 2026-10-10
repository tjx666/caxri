import { CaxriError, isCaxriError } from '@caxri/protocol';
import { ProjectStatusSummaryErrorMessage } from 'caxri';

import { resolveServerExecutable, serverProcessEnvironment } from '../executables';

const GENERIC_GIT_FAILURE_MESSAGE = 'The Git operation failed. Open Logs for details.';

/**
 * Closed cause of a failed Git command for structured logs. `exit` is Git answering with a non-zero status; `cancelled`
 * is the request's own AbortSignal ending the child because its caller left (fast Source Control navigation); every
 * other reason means Git could not answer at all.
 */
export type GitFailureReason =
    | 'cancelled'
    | 'exit'
    | 'not-found'
    | 'output-limit'
    | 'timeout'
    | 'xcode-license'
    | 'xcode-tools-missing';

interface GitFailureShape {
    code?: string;
    killed?: boolean;
    message?: string;
    name?: string;
    stderr?: string;
}

/**
 * MacOS ships `/usr/bin/git` as an `xcrun` shim; without the Command Line Tools it exits with this stderr (and asks the
 * OS to offer an install) instead of running Git.
 */
const XCODE_TOOLS_MISSING =
    /xcrun: error: invalid active developer path|no developer tools were found/;

export function classifyGitFailure(error: unknown): GitFailureReason {
    const failure = error as GitFailureShape;
    // Node rejects an `execFile` whose `signal` aborted with an `AbortError` carrying no exit status at all.
    if (failure.code === 'ABORT_ERR' || failure.name === 'AbortError') return 'cancelled';
    if (failure.code === 'ENOENT') return 'not-found';
    if (failure.killed || failure.message?.toLowerCase().includes('timed out')) return 'timeout';
    if (
        failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
        failure.message?.includes('maxBuffer')
    )
        return 'output-limit';
    const stderr = failure.stderr?.toLowerCase() ?? '';
    if (stderr.includes('you have not agreed to the xcode license agreements'))
        return 'xcode-license';
    if (XCODE_TOOLS_MISSING.test(stderr)) return 'xcode-tools-missing';
    return 'exit';
}

/**
 * `allowFailure` callers treat a non-zero exit as an answer ("no blame yet", "no origin"), so that outcome stays at
 * debug. A missing Git, a timeout, or a blocked toolchain is never an answer: it silently blanks the same features, so
 * it keeps its warn record and cause even when the caller tolerates it. A cancellation is the caller leaving on
 * purpose, routine during fast navigation, so it stays at debug where it is still countable.
 */
export function gitFailureLogLevel(
    reason: GitFailureReason,
    allowFailure: boolean | undefined,
): 'debug' | 'warn' {
    return reason === 'cancelled' || (allowFailure === true && reason === 'exit')
        ? 'debug'
        : 'warn';
}

/**
 * Git resolves through the login-shell PATH boundary like every other external CLI: a packaged app inherits launchd's
 * constrained PATH, so the helpers Git itself execs (credential helpers, GPG signing, LFS filters, hooks) would
 * otherwise miss Homebrew-style directories. An unresolvable Git raises the same ENOENT shape `execFile` would, so it
 * is classified exactly like one the OS could not spawn.
 */
export async function resolveGitLaunch(): Promise<{
    environment: NodeJS.ProcessEnv;
    executable: string;
}> {
    const executable = await resolveServerExecutable('git');
    if (!executable) {
        const missing = new Error('git was not found') as NodeJS.ErrnoException;
        missing.code = 'ENOENT';
        throw missing;
    }
    return { executable, environment: await serverProcessEnvironment() };
}

export function describeGitFailure(
    error: unknown,
    { missingRepoRoot = false }: { missingRepoRoot?: boolean } = {},
): string {
    // Deliberately not `NodeJS.ErrnoException` here: that type inherits `Error`'s required
    // `message: string`, but `error` is `unknown` at this catch boundary and a thrown value is not
    // guaranteed to be an `Error` instance with a `message` at runtime.
    const failure = error as GitFailureShape;
    switch (classifyGitFailure(error)) {
        case 'cancelled': {
            return 'The Git operation was cancelled.';
        }
        case 'not-found': {
            return 'Git is not installed or is unavailable on PATH.';
        }
        case 'timeout': {
            return 'The Git operation timed out.';
        }
        case 'output-limit': {
            return 'Git output exceeded the safety limit.';
        }
        case 'xcode-license': {
            return 'Git is blocked by the Xcode license agreement. Run sudo xcodebuild -license in Terminal, then retry.';
        }
        case 'xcode-tools-missing': {
            return 'Git needs the Xcode Command Line Tools. Run xcode-select --install in Terminal, then retry.';
        }
        case 'exit': {
            break;
        }
    }
    const stderr = failure.stderr?.toLowerCase() ?? '';
    if (missingRepoRoot && stderr.includes('not a git repository'))
        return ProjectStatusSummaryErrorMessage.missingGitRepository;
    // Sync (pull/push) failures the user can act on directly; anything else falls through to the
    // generic wording so raw remote stderr never leaks into the UI.
    if (
        /the upstream branch of your current branch does not match\s+the name of your current branch/.test(
            stderr,
        )
    )
        return 'Push failed because the current branch and its upstream have different names. Check the intended remote branch and update the upstream or push target before retrying.';
    if (stderr.includes('no tracking information') || stderr.includes('has no upstream branch'))
        return 'The current branch has no upstream branch to sync with.';
    if (
        stderr.includes('would be overwritten by merge') ||
        stderr.includes('cannot pull with rebase')
    )
        return 'Local changes block the pull. Commit, stash, or discard them first.';
    if (stderr.includes('non-fast-forward') || stderr.includes('fetch first'))
        return 'The push was rejected. Pull the remote changes first.';
    if (stderr.includes('divergent branches'))
        return 'Local and remote history diverged. Set a pull strategy (merge or rebase) and try again.';
    if (stderr.includes('could not read from remote') || stderr.includes('authentication failed'))
        return 'Unable to reach the remote repository. Check the remote URL and your credentials.';
    return GENERIC_GIT_FAILURE_MESSAGE;
}

/**
 * Wraps a raw `execFile` fault as a `GIT` error while keeping the user-facing wording. An aborted child becomes
 * `CANCELLED`, the code every other abandoned request settles with, so no caller reports it as a Git failure.
 */
export function toGitError(error: unknown, options?: { missingRepoRoot?: boolean }): CaxriError {
    if (isCaxriError(error)) return error;
    if (classifyGitFailure(error) === 'cancelled')
        return new CaxriError('CANCELLED', 'Runtime request was canceled');
    return new CaxriError('GIT', describeGitFailure(error, options));
}

/**
 * Restores the structural missing-root diagnosis when the Git command boundary already wrapped its stderr.
 */
export function describeGitSummaryFailure(error: unknown, isMissingRepoRoot: boolean): string {
    const message = toGitError(error, { missingRepoRoot: isMissingRepoRoot }).message;
    return isMissingRepoRoot && message === GENERIC_GIT_FAILURE_MESSAGE
        ? ProjectStatusSummaryErrorMessage.missingGitRepository
        : message;
}
