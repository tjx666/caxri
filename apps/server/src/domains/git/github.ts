import type { GitRepositorySummary as GitRepoSummary } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { parseGitHubRemote } from '@caxri/utils';

import type { GitHubPullRequestStore } from '../external-status';
import { ExternalStatusCliError } from '../external-status';

export interface GitHubPullRequestReadOptions {
    github: GitHubPullRequestStore;
    /**
     * Set when the user explicitly asked Source Control to refresh, so a force-push is visible immediately instead of
     * waiting out the shared record's TTL. Automatic revalidation leaves it unset and reuses the record.
     */
    isForced?: boolean;
    logger: StructuredLogger;
    originRemote: (rootPath: string) => Promise<string>;
    /**
     * Admits the read through the Git command semaphore, keeping a network-bound `gh` call inside the same concurrency
     * budget the rest of the Git domain respects.
     */
    schedule: <T>(work: () => Promise<T>) => Promise<T>;
}

/**
 * Reads GitHub pull-request metadata for one repository through the Server-wide projection, without granting the
 * Renderer CLI access. The store spawns `gh` through the shared external-status runner, so this read is governed by the
 * same per-source quota circuit as the sidebar sweep and the Status panel, and joins their record instead of issuing a
 * query of its own. Resolves to `undefined` when the repository has no GitHub `origin` or its branch has no pull
 * request.
 */
export async function readGitHubPullRequestView(
    repo: GitRepoSummary,
    options: GitHubPullRequestReadOptions,
): Promise<string | undefined> {
    const remote = parseGitHubRemote(await options.originRemote(repo.rootPath));
    if (!remote) return undefined;
    const startedAt = performance.now();
    return options.schedule(async () => {
        try {
            const output = await options.github.view({
                branch: repo.branch,
                cwd: repo.rootPath,
                maxAgeMs: options.isForced ? 0 : undefined,
                owner: remote.owner,
                repo: remote.repo,
            });
            options.logger.write('info', logEventCatalog.git.githubCommand, {
                durationMs: performance.now() - startedAt,
                fields: { operation: 'pr.view' },
            });
            return output;
        } catch (error) {
            // Deliberately not `NodeJS.ErrnoException` here: that type inherits `Error`'s required `message: string`,
            // but `error` is `unknown` at this catch boundary and a thrown value is not guaranteed to be an `Error`
            // instance with a `message` at runtime.
            const failure = error as { code?: string; kind?: string };
            /**
             * Closed fields only: `gh` stderr and exec faults name the repository, the branch, and the argv, which the
             * Git log contract keeps out of diagnostics.
             */
            options.logger.write('warn', logEventCatalog.git.githubCommandFailed, {
                durationMs: performance.now() - startedAt,
                fields: {
                    operation: 'pr.view',
                    reason: error instanceof ExternalStatusCliError ? error.kind : 'unknown',
                    exitCode: error instanceof ExternalStatusCliError ? error.exitCode : null,
                },
            });
            if (failure.kind === 'not-found' || failure.code === 'ENOENT')
                throw new CaxriError('UNAVAILABLE', 'GitHub CLI is not available on PATH');
            if (failure.kind === 'not-logged-in')
                throw new CaxriError(
                    'UNAVAILABLE',
                    'GitHub CLI is not signed in; run gh auth login',
                );
            if (failure.kind === 'rate-limited')
                throw new CaxriError(
                    'UNAVAILABLE',
                    'GitHub API rate limit reached; retry after it resets',
                );
            throw new CaxriError('GIT', 'Unable to load the pull request for the current branch');
        }
    });
}
