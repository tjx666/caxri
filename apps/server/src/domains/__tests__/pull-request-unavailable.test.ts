import { describe, expect, it } from 'vitest';

import { ExternalStatusCliError, pullRequestUnavailable } from '../external-status';

describe('pull request lookup failures', () => {
    // Issue #1345: `not-logged-in` must not read as "you were never signed in" to a user authenticated only through
    // `GH_TOKEN` — Caxri's external commands deliberately never forward that variable, so the hint has to say so.
    it.each([
        ['not-found', 'GitHub CLI is not installed. Install gh, then refresh.'],
        [
            'not-logged-in',
            'GitHub CLI is not signed in. Run gh auth login, then refresh. A GH_TOKEN environment variable alone is not enough — Caxri does not forward personal shell credentials to CLI checks.',
        ],
        ['rate-limited', 'GitHub API rate limit reached. Refresh after the limit resets.'],
        ['other', 'Could not check pull requests. Open Logs for details, then refresh.'],
    ] as const)('maps %s to a safe recovery hint', (kind, hint) => {
        expect(
            pullRequestUnavailable(new ExternalStatusCliError('gh', kind, 'private output')),
        ).toEqual({
            reason: kind,
            hint,
        });
    });

    it('states when a paused GitHub budget resumes', () => {
        const error = new ExternalStatusCliError('gh', 'rate-limited', 'private output');
        const retryAt = Date.now() + 30 * 60_000;
        error.retryAt = retryAt;
        const time = new Date(retryAt).toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
        });
        expect(pullRequestUnavailable(error)).toEqual({
            reason: 'rate-limited',
            hint: `GitHub API rate limit reached. Caxri retries after ${time}.`,
        });
    });

    it('ignores a deadline the snapshot has already outlived', () => {
        const error = new ExternalStatusCliError('gh', 'rate-limited', 'private output');
        error.retryAt = Date.now() - 1;
        expect(pullRequestUnavailable(error).hint).toBe(
            'GitHub API rate limit reached. Refresh after the limit resets.',
        );
    });
});
