import { CaxriError, isCaxriError } from '@caxri/protocol';
import { ProjectStatusSummaryErrorMessage } from 'caxri';

const GENERIC_GIT_FAILURE_MESSAGE = 'The Git operation failed. Open Logs for details.';

export function describeGitFailure(
    error: unknown,
    { missingRepoRoot = false }: { missingRepoRoot?: boolean } = {},
): string {
    // Deliberately not `NodeJS.ErrnoException` here: that type inherits `Error`'s required
    // `message: string`, but `error` is `unknown` at this catch boundary and a thrown value is not
    // guaranteed to be an `Error` instance with a `message` at runtime.
    const failure = error as {
        code?: string;
        killed?: boolean;
        message?: string;
        stderr?: string;
    };
    if (failure.code === 'ENOENT') return 'Git is not installed or is unavailable on PATH.';
    if (failure.killed || failure.message?.toLowerCase().includes('timed out'))
        return 'The Git operation timed out.';
    if (
        failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
        failure.message?.includes('maxBuffer')
    ) {
        return 'Git output exceeded the safety limit.';
    }
    const stderr = failure.stderr?.toLowerCase() ?? '';
    if (stderr.includes('you have not agreed to the xcode license agreements'))
        return 'Git is blocked by the Xcode license agreement. Run sudo xcodebuild -license in Terminal, then retry.';
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
 * Wraps a raw `execFile` fault as a `GIT` error while keeping the user-facing wording.
 */
export function toGitError(error: unknown, options?: { missingRepoRoot?: boolean }): CaxriError {
    return isCaxriError(error) ? error : new CaxriError('GIT', describeGitFailure(error, options));
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
