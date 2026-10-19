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

import type { CliFailureKind, ExternalStatusRunner } from '../external-status';
import {
    chooseMergeMethod,
    ExternalStatusCliError,
    REPO_MERGE_SETTINGS_FIELDS,
    repoMergeSettingsSchema,
} from '../external-status';

type MergeMethod = ServerOperationResult<'git.mergePullRequest'>['method'];

/**
 * The `gh` call a merge failed in: reading the repository's allowed methods, or the merge itself.
 */
type MergeStep = 'pr.merge' | 'repo.view';

/**
 * Closed cause of a failed merge for `git.github_command_failed`. A `gh` failure keeps the shared CLI classifier's
 * kind; the others are outcomes this flow decides itself. Deliberately never the fault message: `gh` stderr names the
 * repository, the Pull Request, and GitHub's policy text, and an exec fault repeats the argv with the head SHA.
 */
type MergeFailureReason = CliFailureKind | 'invalid-response' | 'no-merge-method' | 'unknown';

/**
 * A repository whose settings allow no merge method is a policy answer, not a `gh` failure, so it carries its own class
 * for the log classification while still reaching the caller as an ordinary `GIT` error.
 */
class NoMergeMethodError extends CaxriError {
    constructor() {
        super('GIT', 'This repository does not allow any merge method');
    }
}

function mergeFailureReason(error: unknown): MergeFailureReason {
    if (error instanceof ExternalStatusCliError) return error.kind;
    if (error instanceof NoMergeMethodError) return 'no-merge-method';
    if (error instanceof SyntaxError || error instanceof z.ZodError) return 'invalid-response';
    return 'unknown';
}

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
 * A GitHub pull request named by its repository slug rather than a local checkout, plus the head it must still have.
 * `cwd` only gives `gh` a working directory; `--repo` decides which repository is merged.
 */
export interface GitHubPullRequestMergeTarget {
    cwd: string;
    headSha: string;
    number: number;
    owner: string;
    repo: string;
}

/**
 * Merges one repository's GitHub pull request. Reads the repository's allowed merge methods first because `gh pr merge`
 * refuses to pick one non-interactively, then pins the merge to the head the user saw with `--match-head-commit`.
 * Deliberately never passes `--delete-branch`: that would also delete the local branch, which a linked worktree may
 * still have checked out, and the repository's own auto-delete setting already covers the remote branch.
 */
export async function mergeGitHubPullRequestAt(
    target: GitHubPullRequestMergeTarget,
    dependencies: Omit<GitPullRequestMergeDependencies, 'originRemote'>,
): Promise<ServerOperationResult<'git.mergePullRequest'>> {
    const slug = `${target.owner}/${target.repo}`;
    const startedAt = performance.now();
    let method: MergeMethod | undefined;
    let step: MergeStep = 'repo.view';
    try {
        const settings = repoMergeSettingsSchema.parse(
            JSON.parse(
                await dependencies.run(
                    'gh',
                    ['repo', 'view', slug, '--json', REPO_MERGE_SETTINGS_FIELDS],
                    target.cwd,
                ),
            ),
        );
        method = chooseMergeMethod(settings);
        if (!method) throw new NoMergeMethodError();
        step = 'pr.merge';
        await dependencies.run(
            'gh',
            [
                'pr',
                'merge',
                String(target.number),
                '--repo',
                slug,
                `--${method}`,
                '--match-head-commit',
                target.headSha,
            ],
            target.cwd,
        );
    } catch (error) {
        dependencies.logger.write('warn', logEventCatalog.git.githubCommandFailed, {
            durationMs: performance.now() - startedAt,
            fields: {
                operation: 'pr.merge',
                step,
                reason: mergeFailureReason(error),
                exitCode: error instanceof ExternalStatusCliError ? error.exitCode : null,
            },
        });
        throw error instanceof CaxriError ? error : mergeFailure(error);
    } finally {
        // A rejected merge may still have changed GitHub's view (a stale head, a new conflict), so the next read must
        // not serve the record that made the merge look possible.
        dependencies.forget(target.owner, target.repo, target.number);
    }
    dependencies.logger.write('info', logEventCatalog.git.githubCommand, {
        durationMs: performance.now() - startedAt,
        fields: { operation: 'pr.merge', method },
    });
    return { method, url: `https://github.com/${slug}/pull/${target.number}` };
}

/**
 * Merges the pull request of a local repository's GitHub `origin`.
 */
export async function mergeGitHubPullRequest(
    repo: GitRepoSummary,
    parameters: Pick<ServerOperationParameters<'git.mergePullRequest'>, 'headSha' | 'number'>,
    dependencies: GitPullRequestMergeDependencies,
): Promise<ServerOperationResult<'git.mergePullRequest'>> {
    const remote = parseGitHubRemote(await dependencies.originRemote(repo.rootPath));
    if (!remote) throw new CaxriError('UNAVAILABLE', 'This repository has no GitHub origin remote');
    return mergeGitHubPullRequestAt(
        { ...remote, cwd: repo.rootPath, headSha: parameters.headSha, number: parameters.number },
        dependencies,
    );
}
