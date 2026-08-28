import { CaxriError, isCaxriError } from '@caxri/protocol';
import { ProjectStatusSummaryErrorMessage } from 'caxri';

export function describeGitFailure(error: unknown): string {
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
    if (stderr.includes('not a git repository'))
        return ProjectStatusSummaryErrorMessage.missingGitRepository;
    // Sync (pull/push) failures the user can act on directly; anything else falls through to the
    // generic wording so raw remote stderr never leaks into the UI.
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
    return 'The Git operation failed. See Runtime logs for details.';
}

/**
 * Wraps a raw `execFile` fault as a `GIT` error while keeping the user-facing wording.
 */
export function toGitError(error: unknown): CaxriError {
    return isCaxriError(error) ? error : new CaxriError('GIT', describeGitFailure(error));
}
