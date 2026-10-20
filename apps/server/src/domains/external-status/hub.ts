import { homedir } from 'node:os';

import type { StructuredLogger } from '@caxri/system';

import type { ExternalStatusRunner } from './command';
import { GITHUB_RATE_LIMIT_QUERY, runExternalStatusCommand } from './command';
import { GitHubPullRequestStore } from './github';
import { GitHubReferenceStore } from './github-reference';
import type { ExternalStatusLimiterOptions, GitHubQuota } from './limiter';
import { ExternalStatusLimiter, parseGitHubRateLimit } from './limiter';

export interface ExternalStatusHubOptions {
    logger?: StructuredLogger;
    now?: () => number;
    pausePath?: ExternalStatusLimiterOptions['pausePath'];
    /**
     * Unguarded CLI runner; the hub is what wraps it in the quota circuit. Overridden in tests.
     */
    runner?: ExternalStatusRunner;
}

/**
 * The Server's single owner of external delivery-status queries. Every `gh`, `linear`, and `vc` spawn goes through
 * {@link ExternalStatusHub.run}, so one circuit breaker governs the whole process instead of four call sites each
 * discovering a rate limit on their own; and every GitHub pull-request read goes through
 * {@link ExternalStatusHub.github}, so the status bar, the Status panel, the sidebar badges, and Source Control share
 * one projection per pull request.
 */
export class ExternalStatusHub {
    private readonly base: ExternalStatusRunner;
    readonly github: GitHubPullRequestStore;
    /**
     * Hover-preview reads for `owner/repo#123`; see {@link GitHubReferenceStore} for why it is not the store above.
     */
    readonly githubReferences: GitHubReferenceStore;
    readonly limiter: ExternalStatusLimiter;
    /**
     * Quota-governed CLI runner. `git` is local and free, so it bypasses the circuit entirely. Declared as a field
     * initializer so it is bound before the constructor body hands it to {@link GitHubPullRequestStore}; the arrow reads
     * `this.base` and `this.limiter` at call time, after the constructor has assigned them.
     */
    readonly run: ExternalStatusRunner = (source, arguments_, cwd) =>
        source === 'git'
            ? this.base(source, arguments_, cwd)
            : this.limiter.guard(source, () => this.base(source, arguments_, cwd));

    constructor(options: ExternalStatusHubOptions = {}) {
        this.base = options.runner ?? runExternalStatusCommand;
        this.limiter = new ExternalStatusLimiter({
            logger: options.logger,
            now: options.now,
            pausePath: options.pausePath,
            probeQuota: () => this.probeGitHubQuota(),
        });
        this.github = new GitHubPullRequestStore(this.run, { now: options.now });
        this.githubReferences = new GitHubReferenceStore(this.run, { now: options.now });
    }

    /**
     * Reads GitHub's GraphQL budget through the unbilled `rateLimit` self-query; see `GITHUB_RATE_LIMIT_QUERY` for why
     * REST `/rate_limit` cannot report it. Deliberately calls the unguarded runner: this probe is how the circuit
     * decides to open.
     */
    private async probeGitHubQuota(): Promise<GitHubQuota | undefined> {
        try {
            return parseGitHubRateLimit(
                await this.base(
                    'gh',
                    ['api', 'graphql', '-f', `query=${GITHUB_RATE_LIMIT_QUERY}`],
                    homedir(),
                ),
            );
        } catch {
            return undefined;
        }
    }

    /**
     * Drops a pull request from every store that holds it, so a merge or close is not outlived by a stale open record
     * in the Status panel's store or in the transcript link and tracker card previews.
     */
    forgetPullRequest(owner: string, repo: string, number: number): void {
        this.github.forget(owner, repo, number);
        this.githubReferences.forget(owner, repo, number);
    }

    clear(): void {
        this.github.clear();
        this.githubReferences.clear();
    }
}
