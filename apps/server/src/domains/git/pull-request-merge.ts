import type {
    GitRepositorySummary as GitRepoSummary,
    ServerOperationParameters,
    ServerOperationResult,
} from '@caxri/protocol';
import { CaxriError, errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { parseGitHubRemote } from '@caxri/utils';
import { z } from 'zod';

import type { ExternalStatusRunner } from '../external-status';
import { ExternalStatusCliError } from '../external-status';

type MergeMethod = ServerOperationResult<'git.mergePullRequest'>['method'];

const repoMergeSettingsSchema = z.object({
    squashMergeAllowed: z.boolean().optional(),
    mergeCommitAllowed: z.boolean().optional(),
    rebaseMergeAllowed: z.boolean().optional(),
});

export interface GitPullRequestMergeDependencies {
    logger: StructuredLogger;
    /**
     * Drops the shared pull-request record so every surface reads the merged state on its next refresh instead of
     * serving the open record until its TTL expires.
     */
    forget(owner: string, repo: string, number: number): void;
    originRemote(rootPath: string): Promise<string>;
    /**
     * The Server-wide external CLI runner, so a merge is governed by the same `gh` quota circuit as every status read.
     */
    run: ExternalStatusRunner;
}

/**
 * Squash first because it is what a repository that allows it almost always wants for agent-delivered branches; a
 * repository that disables it states its preference by what remains.
 */
export function chooseMergeMethod(
    settings: z.infer<typeof repoMergeSettingsSchema>,
): MergeMethod | undefined {
    if (settings.squashMergeAllowed) return 'squash';
    if (settings.mergeCommitAllowed) return 'merge';
    if (settings.rebaseMergeAllowed) return 'rebase';
    return undefined;
}

/**
 * `gh` prefixes its failures with a status glyph and may append usage text; the first meaningful line is what GitHub
 * actually said, such as "the base branch policy prohibits the merge".
 */
function githubFailureMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : errorMessage(error, '');
    const line = raw
        .split('\n')
        .map((candidate) => candidate.replace(/^[X!✗]\s+/u, '').trim())
        .find(Boolean);
    return line ?? 'GitHub did not accept the merge';
}

function mergeFailure(error: unknown): CaxriError {
    if (error instanceof ExternalStatusCliError) {
        if (error.kind === 'not-found')
            return new CaxriError('UNAVAILABLE', 'GitHub CLI is not available on PATH');
        if (error.kind === 'not-logged-in')
            return new CaxriError(
                'UNAVAILABLE',
                'GitHub CLI is not logged in; run `gh auth login`',
            );
        if (error.kind === 'rate-limited')
            return new CaxriError(
                'UNAVAILABLE',
                'GitHub API rate limit reached; retry after it resets',
            );
    }
    return new CaxriError('GIT', githubFailureMessage(error));
}

/**
 * Merges one repository's GitHub pull request. Reads the repository's allowed merge methods first because `gh pr merge`
 * refuses to pick one non-interactively, then pins the merge to the head the user saw with `--match-head-commit`.
 * Deliberately never passes `--delete-branch`: that would also delete the local branch, which a linked worktree may
 * still have checked out, and the repository's own auto-delete setting already covers the remote branch.
 */
export async function mergeGitHubPullRequest(
    repo: GitRepoSummary,
    parameters: Pick<ServerOperationParameters<'git.mergePullRequest'>, 'headSha' | 'number'>,
    dependencies: GitPullRequestMergeDependencies,
): Promise<ServerOperationResult<'git.mergePullRequest'>> {
    const remote = parseGitHubRemote(await dependencies.originRemote(repo.rootPath));
    if (!remote) throw new CaxriError('UNAVAILABLE', 'This repository has no GitHub origin remote');
    const slug = `${remote.owner}/${remote.repo}`;
    const startedAt = performance.now();
    let method: MergeMethod | undefined;
    try {
        const settings = repoMergeSettingsSchema.parse(
            JSON.parse(
                await dependencies.run(
                    'gh',
                    [
                        'repo',
                        'view',
                        slug,
                        '--json',
                        'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed',
                    ],
                    repo.rootPath,
                ),
            ),
        );
        method = chooseMergeMethod(settings);
        if (!method) throw new CaxriError('GIT', 'This repository does not allow any merge method');
        await dependencies.run(
            'gh',
            [
                'pr',
                'merge',
                String(parameters.number),
                '--repo',
                slug,
                `--${method}`,
                '--match-head-commit',
                parameters.headSha,
            ],
            repo.rootPath,
        );
    } catch (error) {
        dependencies.logger.write('warn', logEventCatalog.git.githubCommandFailed, {
            durationMs: performance.now() - startedAt,
            fields: { operation: 'pr.merge', error: errorMessage(error, 'unknown') },
        });
        throw error instanceof CaxriError ? error : mergeFailure(error);
    } finally {
        // A rejected merge may still have changed GitHub's view (a stale head, a new conflict), so the next read must
        // not serve the record that made the merge look possible.
        dependencies.forget(remote.owner, remote.repo, parameters.number);
    }
    dependencies.logger.write('info', logEventCatalog.git.githubCommand, {
        durationMs: performance.now() - startedAt,
        fields: { operation: 'pr.merge', method },
    });
    return { method };
}
