import type { ProjectStatusError } from '@caxri/protocol';

import { ExternalStatusCliError } from '../external-status';
import { projectStatusCliError } from './external';

/**
 * The GitHub part of a repository's status when there is no pull request to show, or reading it failed. A function, not
 * a shared literal: each caller gets its own arrays rather than aliases of one.
 */
export function emptyGitHubLoad(): {
    acceptances: [];
    linearIssues: [];
    errors: ProjectStatusError[];
} {
    return { acceptances: [], linearIssues: [], errors: [] };
}

/**
 * The GitHub part of a repository's status after `gh` failed for a reason other than "no pull request": one `github`
 * error row carrying the failure kind and, for a rate limit, when to retry.
 */
export function failedGitHubLoad(error: unknown): ReturnType<typeof emptyGitHubLoad> {
    const failure =
        error instanceof ExternalStatusCliError
            ? error
            : new ExternalStatusCliError('gh', 'other', String(error));
    return {
        ...emptyGitHubLoad(),
        errors: [projectStatusCliError('gh', failure.kind, { retryAt: failure.retryAt })],
    };
}
