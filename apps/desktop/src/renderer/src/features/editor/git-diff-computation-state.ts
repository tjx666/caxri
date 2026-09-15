import type { EditorLoadAction } from './editor-load-state';
import type { GitDiffComputationOutcome } from './git-diff-stall-watch';

/**
 * Says what did not happen without claiming to know why, and denies the reading the silent version invited: two panes
 * with no highlights are exactly what an unchanged file looks like, so the sentence has to rule that out explicitly. No
 * Worker, no timeout, no IPC — the user never asked for a diff to be computed anywhere in particular.
 */
export const DIFF_STALL_REASON =
    "Couldn't compare these two versions. This isn't a result — the comparison never finished, so the file may well have changed.";

/**
 * Translates one diff computation's outcome into the editor surface's load transition, so the diff shares the file
 * editor's single failure vocabulary instead of growing a second one. `attempt` travels with the outcome because a
 * stall can land long after the user pressed Retry, and an outcome that belongs to an abandoned attempt must not paint
 * over the one now in flight. See issue #978.
 */
export function gitDiffComputationAction(
    outcome: GitDiffComputationOutcome,
    attempt: number,
): EditorLoadAction {
    return outcome === 'stalled'
        ? { type: 'failed', attempt, reason: DIFF_STALL_REASON, tone: 'failed' }
        : { type: 'succeeded', attempt };
}
