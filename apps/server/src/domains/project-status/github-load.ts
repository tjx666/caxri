import type { ProjectStatusError } from '@caxri/protocol';

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
