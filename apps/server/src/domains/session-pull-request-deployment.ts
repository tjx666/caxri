import type { SessionDeployment, SessionPullRequest } from '@caxri/protocol';
import { z } from 'zod';

import type { GitHubPullRequestStore } from './external-status';
import type { VercelDeploymentStore } from './project-status';

/**
 * `gh pr view --json mergeCommit` reports `null` until the pull request is actually merged, and Caxri only asks about
 * merged ones, so anything else means GitHub has not published the commit yet.
 */
const mergeCommitSchema = z.object({
    mergeCommit: z.object({ oid: z.string().min(7) }).nullish(),
});

const PULL_REQUEST_URL =
    /^https:\/\/github\.com\/(?<owner>[\w.-]+)\/(?<repo>[\w.-]+)\/pull\/(?<number>\d+)(?:$|[/?#])/;

export interface PullRequestOrigin {
    number: number;
    owner: string;
    repo: string;
}

/**
 * The repository a Session's pull request lives in. Taken from the pull request's own URL rather than from the
 * Session's Git remote, because the Agent may have opened it from a linked worktree whose remote differs.
 */
export function pullRequestOrigin(url: string): PullRequestOrigin | undefined {
    const groups = PULL_REQUEST_URL.exec(url)?.groups;
    if (!groups) return undefined;
    const number = Number(groups.number);
    return Number.isSafeInteger(number) && number > 0
        ? { number, owner: groups.owner, repo: groups.repo }
        : undefined;
}

/**
 * Two commit identifiers name the same commit. Vercel records the full hash while GitHub may abbreviate it, so the
 * shorter one is compared as a prefix of the longer — which is what an abbreviated hash means.
 */
export function isSameCommit(left: string, right: string): boolean {
    const [shorter, longer] =
        left.length <= right.length
            ? [left.toLowerCase(), right.toLowerCase()]
            : [right.toLowerCase(), left.toLowerCase()];
    return shorter.length >= 7 && longer.startsWith(shorter);
}

export interface SessionDeploymentResolverDependencies {
    github: GitHubPullRequestStore;
    vercel: VercelDeploymentStore;
}

/**
 * Decides whether a Session's merged pull request is what production is currently serving.
 *
 * The sidebar row would otherwise stop at "merged", which is the moment the work left the Agent's hands rather than the
 * moment it reached users — the state the maintainer actually waits for. Only an exact match counts: the hosting
 * provider's live production deployment must have been built from this pull request's own merge commit. The next merge
 * moves production to another commit and this row silently goes back to reporting a merge, which is correct, because
 * the delivery it describes is no longer the one being served.
 */
export async function resolveSessionDeployment(
    dependencies: SessionDeploymentResolverDependencies,
    value: SessionPullRequest,
    cwd: string,
): Promise<SessionDeployment | undefined> {
    if (value.state !== 'merged') return undefined;
    const origin = pullRequestOrigin(value.url);
    if (!origin) return undefined;
    /**
     * Served from the record the sweep just fetched for this same pull request, so establishing the merge commit
     * normally costs no query at all.
     */
    const json = await dependencies.github.view({ cwd, ...origin });
    if (!json) return undefined;
    let mergeCommit: string | undefined;
    try {
        mergeCommit = mergeCommitSchema.parse(JSON.parse(json)).mergeCommit?.oid;
    } catch {
        // A record this parser cannot read is one the badge simply cannot be drawn from.
        return undefined;
    }
    if (!mergeCommit) return undefined;
    const production = await dependencies.vercel.production(origin.owner, origin.repo);
    if (!production?.commitSha || !isSameCommit(production.commitSha, mergeCommit))
        return undefined;
    return { state: production.state };
}

/**
 * Adds the production deployment this Session's merged pull request produced, when production is currently serving
 * exactly that merge commit.
 *
 * Run on every sweep rather than only on a lookup, because the deployment lands minutes after the merge that a settled
 * entry then caches for a quarter of an hour. While a merged pull request has no matching deployment the entry is also
 * held to the open cadence (`openExpiresAt`), so the badge appears when the build finishes instead of whenever the next
 * unrelated change happens to expire the row.
 */
export async function withSessionDeployment<
    Entry extends { expiresAt: number; value?: SessionPullRequest },
>(
    dependencies: SessionDeploymentResolverDependencies,
    entry: Entry,
    options: { onError: (error: unknown) => void; openExpiresAt: number; rootPath: string },
): Promise<Entry> {
    if (entry.value?.state !== 'merged') return entry;
    let deployment: SessionDeployment | undefined;
    try {
        deployment = await resolveSessionDeployment(dependencies, entry.value, options.rootPath);
    } catch (error) {
        // The row stays exactly as the pull request lookup left it rather than failing the Session's projection.
        options.onError(error);
    }
    // Always rewritten, so a badge never outlives the build it described: the next merge moves production onto another
    // commit, and this row must go back to reporting a plain merge.
    if (deployment) return { ...entry, value: { ...entry.value, deployment } };
    return {
        ...entry,
        expiresAt: Math.min(entry.expiresAt, options.openExpiresAt),
        value: { ...entry.value, deployment: undefined },
    };
}
