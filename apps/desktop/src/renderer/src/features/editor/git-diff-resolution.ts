import type { GitDiffDocument } from '@caxri/protocol';

/**
 * A working-tree diff whose document comes back `null` has nothing left to compare: the change was committed, staged,
 * or undone — routinely by an Agent working in the background while the user was still reading the diff. The tab used
 * to close itself at that moment, which removed a document from the screen without the user asking and without saying
 * why. It now stays and explains itself instead. See issue #993.
 */
export const RESOLVED_GIT_DIFF_REASON =
    'This file no longer differs from what the diff compared. The change was committed or undone.';

export const RESOLVED_GIT_DIFF_ACTION_LABEL = 'Check again';
export const RESOLVED_GIT_DIFF_PENDING_LABEL = 'Checking…';

/**
 * Whether a `null` document is an answer or just the absence of one. Only a read that completed after this surface
 * mounted may be reported as "no longer differs": a `null` left over from a previous mount is a cached verdict about a
 * file the user has since changed again, and announcing it would be the same wrong claim the auto-close made.
 */
export function isResolvedGitDiff(input: {
    document: GitDiffDocument | null | undefined;
    isError: boolean;
    isFetchedAfterMount: boolean;
}): boolean {
    return input.document === null && input.isFetchedAfterMount && !input.isError;
}

/**
 * The action label doubles as the progress state. A re-check that finds the file still unchanged renders the identical
 * screen, so without this the button would look inert and the user could not tell the check from a dead control.
 */
export function resolvedGitDiffActionLabel(isFetching: boolean): string {
    return isFetching ? RESOLVED_GIT_DIFF_PENDING_LABEL : RESOLVED_GIT_DIFF_ACTION_LABEL;
}
