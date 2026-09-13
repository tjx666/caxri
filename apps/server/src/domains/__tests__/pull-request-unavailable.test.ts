import { describe, expect, it } from 'vitest';

import { ExternalStatusCliError } from '../external-status';
import { pullRequestUnavailable } from '../pull-request-unavailable';

describe('pull request lookup failures', () => {
    it.each([
        ['not-found', 'GitHub CLI is not installed. Install gh, then refresh.'],
        ['not-logged-in', 'GitHub CLI is not signed in. Run gh auth login, then refresh.'],
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
});
