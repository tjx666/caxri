/**
 * How many times one diff surface may recover from a stall on its own — destroying and recreating the stalled Worker,
 * then recomputing — before it has to hand the stall to the user instead. Bounded at one: the renderer-process failure
 * behind issue #962 breaks every later Worker the same way, so retrying without limit would spin silently rather than
 * ever surfacing the explicit failure this issue also requires. See `git-diff-computation-state.ts` for what the user
 * sees once this budget is spent.
 */
export const MAX_AUTOMATIC_WORKER_RECOVERIES = 1;

/**
 * `idle` — nothing has stalled yet, or the last stall was cleared by a successful comparison. `recovering` — this
 * surface has spent its automatic attempt and is waiting for the recomputed diff. `exhausted` — a second stall arrived
 * after the automatic attempt, so the surface must stop acting on its own and ask the user (Retry).
 */
export type DiffWorkerRecoveryState =
    | { readonly attempts: number; readonly status: 'exhausted' }
    | { readonly attempts: number; readonly status: 'idle' }
    | { readonly attempts: number; readonly status: 'recovering' };

/**
 * `stalled` — the owning diff missed its comparison budget or its Worker never sent a first reply. `computed` — a diff
 * answered, whether or not it had previously stalled. `restarted` — the surface switched to a different comparison
 * (issue #978's `editorLoadReducer` names the same transition `restarted`), so a recovery budget spent on the previous
 * target must not carry over to this one.
 */
export type DiffWorkerRecoveryAction =
    { type: 'computed' } | { type: 'restarted' } | { type: 'stalled' };

export const initialDiffWorkerRecoveryState: DiffWorkerRecoveryState = {
    attempts: 0,
    status: 'idle',
};

/**
 * Decides what a diff surface that just missed its comparison budget should do next: recover on its own — destroy and
 * recreate the stalled Worker, then recompute — or stop and let the user retry by hand.
 *
 * Pure and free of the Worker, Monaco, and diagnostic-reporting APIs on purpose: the recovery _policy_ (how many
 * automatic attempts a surface gets, and when it has to give up) is what this module owns, so it is testable without a
 * DOM, a Worker thread, or a rendered editor. Performing the recovery — releasing the stalled Worker and asking the
 * surface to recompute — is the caller's job once this returns `recovering`.
 *
 * Answers with the identical state object whenever nothing changes, so a dispatch made from an effect cannot loop:
 * React bails out of the re-render when a reducer returns the same reference it was given.
 */
export function diffWorkerRecoveryReducer(
    state: DiffWorkerRecoveryState,
    action: DiffWorkerRecoveryAction,
): DiffWorkerRecoveryState {
    switch (action.type) {
        case 'restarted':
            return state === initialDiffWorkerRecoveryState
                ? state
                : initialDiffWorkerRecoveryState;
        case 'computed':
            return state.status === 'idle' ? state : { attempts: state.attempts, status: 'idle' };
        case 'stalled':
            if (state.attempts >= MAX_AUTOMATIC_WORKER_RECOVERIES)
                return state.status === 'exhausted'
                    ? state
                    : { attempts: state.attempts, status: 'exhausted' };
            return { attempts: state.attempts + 1, status: 'recovering' };
    }
}
