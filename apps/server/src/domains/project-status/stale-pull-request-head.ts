import type { ProjectStatusRepository as ProjectStatusRepo } from '@caxri/protocol';
import { rememberBounded } from '@caxri/utils';

import type { BranchPublicationContext } from './branch';

type PullRequest = NonNullable<ProjectStatusRepo['pullRequest']>;

/**
 * Bounds the remembered refetches; each entry is one open pull request whose shared record lagged its local branch.
 */
const MAX_TRACKED_PULL_REQUESTS = 256;

/**
 * Notices a shared pull-request record that predates a push this checkout already saw. After an Agent pushes, the
 * remote-tracking ref moves at once and its Git event refreshes Project Status, but the shared GitHub record may be up
 * to its TTL old, so the merge button kept the previous head and GitHub refused the merge with `Head branch was
 * modified`. A record whose open pull request names this branch at a head other than the local `origin/<branch>` is
 * therefore read again from GitHub.
 *
 * Each tracking head forces at most one refetch: GitHub can lag a push by a few seconds, and a branch whose local
 * tracking ref disagrees with GitHub for good (a rewritten remote, a fork) must not turn every automatic refresh into a
 * paid query.
 *
 * @see https://github.com/tjx666/caxri/issues/3709
 */
export class StalePullRequestHeadTracker {
    readonly #refetchedFor = new Map<string, string>();

    /**
     * Reads and parses the pull request, reaching GitHub again when the record served lags `context`'s tracking ref. An
     * explicit user refresh (`isForced`) already bypasses the shared record; an automatic revalidation may reuse it.
     * Resolves `undefined` when the branch has no pull request.
     */
    async read<Parsed extends { pullRequest?: PullRequest }>(
        context: Pick<BranchPublicationContext, 'branch' | 'trackingHead'>,
        isForced: boolean,
        source: {
            view(maxAgeMs: number | undefined): Promise<string | undefined>;
            parse(output: string): Parsed;
        },
    ): Promise<Parsed | undefined> {
        const output = await source.view(isForced ? 0 : undefined);
        if (!output) return undefined;
        const parsed = source.parse(output);
        if (isForced || !this.shouldRefetch(parsed.pullRequest, context)) return parsed;
        const fresh = await source.view(0);
        return fresh ? source.parse(fresh) : undefined;
    }

    /**
     * Whether `pullRequest`, read from the shared cache, should be fetched again for `context`. Records the refetch, so
     * the same tracking head answers no from then on.
     */
    shouldRefetch(
        pullRequest: PullRequest | undefined,
        context: Pick<BranchPublicationContext, 'branch' | 'trackingHead'>,
    ): boolean {
        const { trackingHead } = context;
        if (
            !trackingHead ||
            !pullRequest?.headSha ||
            pullRequest.headSha === trackingHead ||
            pullRequest.headBranch !== context.branch ||
            (pullRequest.lifecycle !== 'open' && pullRequest.lifecycle !== 'draft')
        )
            return false;
        if (this.#refetchedFor.get(pullRequest.url) === trackingHead) return false;
        rememberBounded(
            this.#refetchedFor,
            pullRequest.url,
            trackingHead,
            MAX_TRACKED_PULL_REQUESTS,
        );
        return true;
    }
}
