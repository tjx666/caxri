import type { EditorLoadAction } from './editor-load-state';
import type { GitDiffComputationOutcome } from './git-diff-stall-watch';

/**
 * Says what did not happen without claiming to know why, and denies the reading the silent version invited: two panes
 * with no highlights are exactly what an unchanged file looks like, so the sentence has to rule that out explicitly. No
 * Worker, no timeout, no IPC: the user never asked for a diff to be computed anywhere in particular.
 */
export const DIFF_STALL_REASON =
    "Couldn't compare these two versions. This isn't a result: the comparison never finished, so the file may well have changed.";

/**
 * The first reply is missing. Shares the sibling reason's vocabulary on purpose: the user asked to see a comparison,
 * not to run one anywhere in particular, so neither the worker nor an attached debugger belongs in the sentence
 * (DESIGN.md, "No implementation vocabulary in the UI"). A debugger startup pause is one reproducible cause of this
 * silence, but silence alone cannot distinguish it from a slow or failed script, so naming it would state a hypothesis
 * as the cause and hand almost every user an instruction they cannot act on. The operator-facing explanation lives in
 * `docs/editor-worker-stalls.md`; the visible text stops at the recovery action.
 */
export const DIFF_WORKER_NOT_STARTED_REASON =
    "Couldn't compare these two versions. This comparison never started, so the file may well have changed. Choose Retry.";

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
    if (outcome === 'computed') return { type: 'succeeded', attempt };
    return {
        type: 'failed',
        attempt,
        reason:
            outcome === 'worker-not-started' ? DIFF_WORKER_NOT_STARTED_REASON : DIFF_STALL_REASON,
        tone: 'failed',
    };
}
