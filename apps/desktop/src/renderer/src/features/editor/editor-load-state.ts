interface EditorLoadAttempt {
    /**
     * The attempt whose outcome the surface is currently waiting for. `retried` bumps it, which is what makes a retry
     * re-run a read whose every other effect dependency is unchanged, and what lets the outcome of an abandoned attempt
     * be discarded instead of painting a stale failure over the attempt now in flight.
     */
    attempt: number;
}

/**
 * Load phases for the editor surface's two asynchronous dependencies: the code editor module and the file behind a tab.
 * Both used to model only "loading" and "loaded", so a failure on either path left the surface showing a spinner with
 * no way out (issue #979). The transitions live here, outside the component, so they are testable without rendering
 * Monaco.
 */
/**
 * `interrupted` is kept apart from `failed` because a cancelled request is an expected outcome rather than something
 * the user can act on — the same rule `isCancelledRequest` applies to toasts — so it must not be announced or coloured
 * as an error, even though it still needs a way out of the spinner.
 */
export type EditorLoadTone = 'failed' | 'interrupted';

export type EditorLoadState =
    | (EditorLoadAttempt & { status: 'loading' | 'ready' })
    | (EditorLoadAttempt & {
          /**
           * Complete plain-language sentence to show the user, including the concrete cause when one is known.
           */
          reason: string;
          status: 'failed';
          tone: EditorLoadTone;
      });

/**
 * `restarted` means the surface switched to a different target, so a failure recorded for the previous one no longer
 * describes what is on screen. `retried` means the user asked for the same target again. `succeeded` and `failed` name
 * the attempt they belong to, because a slow outcome can arrive after the user has already moved on.
 */
export type EditorLoadAction =
    | { type: 'restarted' }
    | { type: 'retried' }
    | { type: 'succeeded'; attempt: number }
    | { type: 'failed'; attempt: number; reason: string; tone: EditorLoadTone };

export const initialEditorLoadState: EditorLoadState = { attempt: 0, status: 'loading' };

/**
 * Answers with the identical state object whenever a transition changes nothing, so a dispatch made from an effect
 * cannot loop: React bails out of the re-render when a reducer returns the same reference it was given.
 */
export function editorLoadReducer(
    state: EditorLoadState,
    action: EditorLoadAction,
): EditorLoadState {
    switch (action.type) {
        case 'restarted':
            return state.status === 'loading'
                ? state
                : { attempt: state.attempt, status: 'loading' };
        case 'retried':
            return { attempt: state.attempt + 1, status: 'loading' };
        case 'succeeded':
            return action.attempt !== state.attempt || state.status === 'ready'
                ? state
                : { attempt: state.attempt, status: 'ready' };
        case 'failed':
            return action.attempt === state.attempt
                ? {
                      attempt: state.attempt,
                      reason: action.reason,
                      status: 'failed',
                      tone: action.tone,
                  }
                : state;
    }
}

/**
 * A failed chunk load carries no cause a user can act on — the file it names is a build asset, not their document — so
 * the recovery sentence replaces the technical one instead of quoting it.
 */
export const EDITOR_LOAD_FAILURE_REASON =
    "The editor didn't load. Reloading the window usually fixes it.";

const EDITOR_RENDER_FAILURE_REASON =
    'This tab ran into an error. Reloading the window usually fixes it.';

/**
 * Chromium's message for a rejected `import()`, and Vite's for a lazy chunk whose stylesheet failed to preload. Both
 * mean the tab's code never arrived, as opposed to arriving and then throwing.
 */
const CHUNK_LOAD_FAILURE_PATTERN =
    /Failed to fetch dynamically imported module|Unable to preload CSS/;

/**
 * The sentence the editor pane shows after its surface threw while rendering. Only the reason differs: a chunk that
 * never loaded and a surface that threw both recover the same way, by reloading the window.
 */
export function editorRenderFailureReason(error: unknown): string {
    return error instanceof Error && CHUNK_LOAD_FAILURE_PATTERN.test(error.message)
        ? EDITOR_LOAD_FAILURE_REASON
        : EDITOR_RENDER_FAILURE_REASON;
}
