import { CaxriError, isCaxriError } from '../../shared/ipc/errors';

export function describeGitFailure(error: unknown): string {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    if (failure.code === 'ENOENT') return 'Git is not installed or is unavailable on PATH.';
    if (failure.killed || failure.message?.toLowerCase().includes('timed out'))
        return 'The Git operation timed out.';
    if (
        failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
        failure.message?.includes('maxBuffer')
    ) {
        return 'Git output exceeded the safety limit.';
    }
    if (failure.stderr?.toLowerCase().includes('not a git repository'))
        return 'The Project root is not a Git repository.';
    return 'The Git operation failed. See Runtime logs for details.';
}

/**
Wraps a raw `execFile` fault as a `GIT` error while keeping the user-facing wording.
 */
export function toGitError(error: unknown): CaxriError {
    return isCaxriError(error) ? error : new CaxriError('GIT', describeGitFailure(error));
}
