/**
 * The exact, already user-facing sentences `describeGitFailure` (`src/runtime/git/errors.ts`) can produce for a
 * `git.summary` failure. Kept in sync manually (not imported: Runtime code is out of the Renderer's dependency graph) —
 * the point is a closed allowlist, not a live reference, so any future Runtime wording drifts into the fallback below
 * instead of leaking unreviewed text into the empty state.
 */
const KNOWN_GIT_SUMMARY_ERROR_COPY: Readonly<Record<string, string>> = {
    'The Project root is not a Git repository.': 'This folder is not a Git repository.',
    'Git is not installed or is unavailable on PATH.':
        'Git is not installed or is unavailable on PATH.',
    'The Git operation timed out.': 'The Git operation timed out.',
    'Git output exceeded the safety limit.': 'Git output exceeded the safety limit.',
};

const FALLBACK_GIT_SUMMARY_ERROR = 'This folder is not a Git repository.';

/**
 * Every other hand-written Git empty state ("Working tree clean.", "No commits yet.", …) is a short, fixed sentence;
 * `summary.error` used to be the one exception, rendered verbatim. Recognized Runtime messages still render (rewording
 * the not-a-repository case into product language), and anything unrecognized falls back to the same friendly sentence
 * instead of risking raw stderr or Runtime jargon reaching the panel.
 */
export function describeSourceControlViewError(error: string): string {
    return KNOWN_GIT_SUMMARY_ERROR_COPY[error] ?? FALLBACK_GIT_SUMMARY_ERROR;
}
