import type { GitDiffDocument } from '@caxri/protocol';

import type { TranslationKey } from '../../../i18n';

/**
 * A working-tree diff whose document comes back `null` has nothing left to compare: the change was committed, staged,
 * or undone, routinely by an Agent working in the background while the user was still reading the diff. The tab used to
 * close itself at that moment, which removed a document from the screen without the user asking and without saying why.
 * It now stays and explains itself instead. See issue #993.
 */
export const RESOLVED_GIT_DIFF_REASON_KEY =
    'editor.gitDiff.resolvedReason' satisfies TranslationKey;

export const RESOLVED_GIT_DIFF_ACTION_LABEL_KEY =
    'editor.gitDiff.checkAgain' satisfies TranslationKey;
export const RESOLVED_GIT_DIFF_PENDING_LABEL_KEY =
    'editor.gitDiff.checking' satisfies TranslationKey;

export type NullGitDiffState = 'failed' | 'pending' | 'resolved';

/**
 * A `null` document is three different situations wearing one value, and the surface has to tell them apart before it
 * can say anything true. `resolved` is the answer "this file no longer differs", and only a read that completed after
 * this surface mounted may claim it: a `null` left over from a previous mount is a cached verdict about a file the user
 * has since changed again, and announcing it would be the same wrong claim the auto-close made. `failed` is a read that
 * did not come back at all: the cached `null` is then not evidence of anything, and calling it `pending` would leave
 * the surface showing "Loading diff…" forever, because nothing is still loading.
 */
export function resolveNullGitDiffState(input: {
    document: GitDiffDocument | null | undefined;
    isError: boolean;
    isFetchedAfterMount: boolean;
}): NullGitDiffState {
    if (input.document !== null) return 'pending';
    if (input.isError) return 'failed';
    return input.isFetchedAfterMount ? 'resolved' : 'pending';
}

/**
 * The action label doubles as the progress state. A re-check that finds the file still unchanged renders the identical
 * screen, so without this the button would look inert and the user could not tell the check from a dead control.
 */
export function resolvedGitDiffActionLabel(isFetching: boolean): TranslationKey {
    return isFetching ? RESOLVED_GIT_DIFF_PENDING_LABEL_KEY : RESOLVED_GIT_DIFF_ACTION_LABEL_KEY;
}
