import { rememberBounded } from '@caxri/utils';
import { z } from 'zod';

import { SingleFlight } from '../single-flight';
import type { ExternalStatusRunner } from './command';

/**
 * Longer than the pull-request store's TTL: an issue title changes far less often than a PR's check rollup, and a hover
 * is an involuntary gesture: the user brushing past a line of output must not turn into a refetch.
 */
const RECORD_TTL_MS = 10 * 60_000;
/**
 * A reference that does not resolve is almost always a number that never existed (a match on ordinary output, a stale
 * paste), so re-asking GitHub buys nothing. Remembered far longer than a hit, and deliberately not forever: a genuinely
 * new issue must become visible without a restart.
 */
const MISSING_TTL_MS = 30 * 60_000;
/**
 * An open or draft pull request is still moving toward merged or closed, and the Renderer re-reads it when the window
 * regains focus. A copy as long as {@link RECORD_TTL_MS} would make a pull request merged in the browser keep showing as
 * open for ten minutes after the user came back, so it expires on the Renderer's own one-minute cadence.
 */
const LIVE_PULL_REQUEST_TTL_MS = 60_000;
const MAX_RECORDS = 256;

const referenceSchema = z.object({
    created_at: z.string().optional(),
    draft: z.boolean().optional(),
    html_url: z.string().optional(),
    number: z.number().int().positive(),
    /**
     * Present only on a pull request; `merged_at` is the one field separating a merged pull request from a closed one,
     * which the issues endpoint reports alike as `state: closed`.
     */
    pull_request: z.looseObject({ merged_at: z.string().nullish() }).nullish(),
    state: z.string().optional(),
    title: z.string().optional(),
    user: z.object({ login: z.string().optional() }).optional(),
});

export interface GitHubReference {
    author: string;
    createdAt: number;
    isDraft: boolean;
    isMerged: boolean;
    isPullRequest: boolean;
    number: number;
    state: string;
    title: string;
    url: string;
}

export interface GitHubReferenceLookup {
    cwd: string;
    number: number;
    owner: string;
    repo: string;
}

export interface GitHubReferenceStoreOptions {
    missingTtlMs?: number;
    /**
     * How long an open or draft pull request is served from cache. Settled references use `ttlMs`.
     */
    livePullRequestTtlMs?: number;
    now?: () => number;
    ttlMs?: number;
}

interface StoredRecord {
    fetchedAt: number;
    /**
     * Absent when GitHub reported no issue or pull request with that number.
     */
    reference?: GitHubReference;
}

/**
 * Recognizes the one failure that is cacheable as absence. Anything else (no network, no credentials, a quota pause)
 * must stay uncached, or a temporary outage would be remembered as "this issue does not exist" for the whole TTL.
 */
function isMissingReference(error: unknown): boolean {
    return error instanceof Error && /not found|could not resolve to|HTTP 404/i.test(error.message);
}

/**
 * Never throws on the CLI's output. Malformed JSON is indistinguishable from a reference with nothing to show, and
 * raising it here would turn a cosmetic hover into an error the user has to dismiss.
 */
function toReference(output: string): GitHubReference | undefined {
    let payload: unknown;
    try {
        payload = JSON.parse(output);
    } catch {
        return undefined;
    }
    const parsed = referenceSchema.safeParse(payload);
    if (!parsed.success) return undefined;
    const { data } = parsed;
    const createdAt = data.created_at ? Date.parse(data.created_at) : NaN;
    return {
        author: data.user?.login ?? '',
        createdAt: Number.isFinite(createdAt) ? Math.trunc(createdAt) : 0,
        isDraft: data.draft ?? false,
        isMerged: Boolean(data.pull_request?.merged_at),
        isPullRequest: data.pull_request != null,
        number: data.number,
        state: data.state ?? 'unknown',
        title: data.title ?? '',
        url: data.html_url ?? '',
    };
}

/**
 * The Server's projection of a GitHub issue or pull request addressed by number, for hover previews over Terminal
 * references.
 *
 * One REST read answers both halves of `owner/repo#123`. `gh pr view` and `gh issue view` each refuse the other's
 * numbers, and nothing in `owner/repo#123` says which one the user is pointing at, so a CLI-shaped read would have to
 * guess, fail, and retry with the other subcommand, spending two processes on every issue. GitHub's REST issues
 * endpoint covers pull requests too and marks them with a `pull_request` key, so one call settles it. It also draws on
 * the REST budget rather than the GraphQL budget `gh pr view` and the sidebar sweep share, which keeps a hover from
 * competing with delivery status.
 *
 * Separate from the pull-request store (`./github.ts`) because it answers a different question ("what is
 * `owner/repo#123`", not "what pull request does this branch have") on a different budget and a different cadence. The
 * two do not share records: a preview needs a title, not a check rollup, and paying for a rollup on hover is the cost
 * this store exists to avoid.
 */
export class GitHubReferenceStore {
    private readonly records = new Map<string, StoredRecord>();
    private readonly requests = new SingleFlight<string, GitHubReference | undefined>();

    constructor(
        private readonly runner: ExternalStatusRunner,
        private readonly options: GitHubReferenceStoreOptions = {},
    ) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private cached(key: string): StoredRecord | undefined {
        const record = this.records.get(key);
        if (!record) return undefined;
        const { reference } = record;
        const ttl = !reference
            ? (this.options.missingTtlMs ?? MISSING_TTL_MS)
            : reference.isPullRequest && !reference.isMerged && reference.state !== 'closed'
              ? (this.options.livePullRequestTtlMs ?? LIVE_PULL_REQUEST_TTL_MS)
              : (this.options.ttlMs ?? RECORD_TTL_MS);
        if (this.now() - record.fetchedAt >= ttl) return undefined;
        rememberBounded(this.records, key, record, MAX_RECORDS);
        return record;
    }

    /**
     * Resolves `owner/repo#number`, or `undefined` when GitHub has no such issue or pull request. Throws only when the
     * CLI itself could not answer, so the caller can tell "there is nothing there" from "we could not find out".
     */
    async view(lookup: GitHubReferenceLookup): Promise<GitHubReference | undefined> {
        const slug = `${lookup.owner}/${lookup.repo}`;
        const key = `${slug}#${lookup.number}`;
        const cached = this.cached(key);
        if (cached) return cached.reference;
        return this.requests.run(key, async () => {
            // A sibling caller may have produced this record while this one queued behind the single-flight.
            const settled = this.cached(key);
            if (settled) return settled.reference;
            let reference: GitHubReference | undefined;
            try {
                const output = await this.runner(
                    'gh',
                    [
                        'api',
                        // Every reference comes from a github.com link; without the flag `gh` would ask whichever host
                        // its configuration or `GH_HOST` names, such as a GitHub Enterprise server.
                        '--hostname',
                        'github.com',
                        `repos/${lookup.owner}/${lookup.repo}/issues/${lookup.number}`,
                    ],
                    lookup.cwd,
                );
                reference = output.trim() ? toReference(output) : undefined;
            } catch (error) {
                if (!isMissingReference(error)) throw error;
            }
            rememberBounded(this.records, key, { fetchedAt: this.now(), reference }, MAX_RECORDS);
            return reference;
        });
    }

    /**
     * Drops one reference's record after Caxri changed it on GitHub (merging a pull request), so the next preview
     * refetches instead of serving the pre-mutation state.
     */
    forget(owner: string, repo: string, number: number): void {
        this.records.delete(`${owner}/${repo}#${number}`);
    }

    clear(): void {
        this.records.clear();
        this.requests.clear();
    }
}
