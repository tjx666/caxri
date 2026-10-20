import { SingleFlight } from '@caxri/system';
import { rememberBounded } from '@caxri/utils';
import { z } from 'zod';

import type { ExternalStatusRunner } from './command';
import { isNoPullRequest } from './command';

/**
 * One field set serves every consumer. The status bar needs `number,title,url`; the Status panel adds `body` (Linear
 * references are extracted from it) and `statusCheckRollup`; the sidebar badge adds `state,isDraft`; Source Control's
 * pull-request diff adds the base/head refs and OIDs; the sidebar's deployment badge adds `mergeCommit`, which is the
 * only way to tell whether the project's current production deployment was built from _this_ delivery; the Status
 * panel's merge action adds `mergeable` and `mergeStateStatus`, which decide whether it is offered and confirmed.
 * Fetching the union once and sharing the record replaces the four independent `gh pr view` calls those surfaces used
 * to issue for the same pull request: `statusCheckRollup`, by far the most expensive field in GraphQL points, is now
 * paid for once per pull request per TTL.
 */
const PULL_REQUEST_FIELDS = [
    'number',
    'title',
    'url',
    'state',
    'isDraft',
    'body',
    'statusCheckRollup',
    'baseRefName',
    'headRefName',
    'baseRefOid',
    'headRefOid',
    'mergeCommit',
    'mergedAt',
    'mergeable',
    'mergeStateStatus',
].join(',');

/**
 * Deliberately longer than the Renderer's 60s polls (`status-bar.tsx`, `primary-sidebar.tsx`). At exactly 60s every
 * poll landed just past expiry: `usePolledQuery` schedules the next request after the previous one settles, so the gap
 * is always 60s plus the round trip, and the shared record was refetched on every single poll, which is the cost this
 * store exists to remove. The extra 30s absorbs that skew; a Server-side event still refreshes earlier when something
 * actually changes.
 */
const RECORD_TTL_MS = 90_000;
/**
 * A branch with no pull request is the common case for `main` and for work an Agent has not delivered yet. Re-asking
 * GitHub every minute costs a full query to learn nothing, so absence is cached far longer than presence.
 */
const MISSING_TTL_MS = 5 * 60_000;
const MAX_RECORDS = 256;
const MAX_REF_ALIASES = 512;

const recordIdentitySchema = z.object({
    headRefName: z.string().min(1).optional(),
    number: z.number().int().positive().optional(),
});

export interface GitHubPullRequestLookup {
    /**
     * Availability indicators need the failed refresh even when a previous PR record exists. Other readers may keep
     * showing that record while GitHub is temporarily unavailable.
     */
    allowStaleOnFailure?: boolean;
    /**
     * Branch to resolve when the pull request number is not known yet. Ignored once `number` is set.
     */
    branch?: string;
    cwd: string;
    /**
     * Maximum age the caller accepts. `0` forces a refetch (explicit user refresh); omitted uses the store's TTL.
     */
    maxAgeMs?: number;
    number?: number;
    owner: string;
    repo: string;
}

interface StoredRecord {
    fetchedAt: number;
    /**
     * Raw `gh pr view` JSON, or `undefined` when GitHub reported no pull request for the reference.
     */
    json?: string;
}

export interface GitHubPullRequestStoreOptions {
    missingTtlMs?: number;
    now?: () => number;
    ttlMs?: number;
}

/**
 * The single canonical projection of a GitHub pull request inside the Server. Records are keyed by pull-request
 * identity (`owner/repo#number`), and a branch lookup is indexed onto the record it resolved to, so the status bar
 * asking by branch and the sidebar asking by number join the same fetch instead of spending two queries on one PR.
 */
export class GitHubPullRequestStore {
    private readonly records = new Map<string, StoredRecord>();
    /**
     * `owner/repo@branch` → `owner/repo#number`, so a branch-shaped lookup can reuse a number-shaped record.
     */
    private readonly refAliases = new Map<string, string>();
    private readonly requests = new SingleFlight<string, string | undefined>();

    constructor(
        private readonly runner: ExternalStatusRunner,
        private readonly options: GitHubPullRequestStoreOptions = {},
    ) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    /**
     * The record a lookup key resolves to, however old it is.
     */
    private stored(lookupKey: string): StoredRecord | undefined {
        return this.records.get(this.refAliases.get(lookupKey) ?? lookupKey);
    }

    private cached(lookupKey: string, maxAgeMs: number | undefined): StoredRecord | undefined {
        const recordKey = this.refAliases.get(lookupKey) ?? lookupKey;
        const record = this.records.get(recordKey);
        if (!record) return undefined;
        const ttl =
            maxAgeMs ??
            (record.json
                ? (this.options.ttlMs ?? RECORD_TTL_MS)
                : (this.options.missingTtlMs ?? MISSING_TTL_MS));
        if (this.now() - record.fetchedAt >= ttl) return undefined;
        rememberBounded(this.records, recordKey, record, MAX_RECORDS);
        return record;
    }

    private remember(lookupKey: string, slug: string, json: string | undefined): void {
        let identity: z.infer<typeof recordIdentitySchema> = {};
        if (json) {
            try {
                const parsed = recordIdentitySchema.safeParse(JSON.parse(json));
                if (parsed.success) identity = parsed.data;
            } catch {
                // Malformed output is still cached under the requested key so the caller's own parser reports it once
                // rather than re-spawning `gh` on every read.
            }
        }
        const recordKey = identity.number === undefined ? lookupKey : `${slug}#${identity.number}`;
        rememberBounded(this.records, recordKey, { fetchedAt: this.now(), json }, MAX_RECORDS);
        if (recordKey !== lookupKey)
            rememberBounded(this.refAliases, lookupKey, recordKey, MAX_REF_ALIASES);
        if (identity.headRefName)
            rememberBounded(
                this.refAliases,
                `${slug}@${identity.headRefName}`,
                recordKey,
                MAX_REF_ALIASES,
            );
    }

    /**
     * Returns the raw `gh pr view` JSON for a pull request, or `undefined` when the reference has none. Callers parse
     * the fields they need; the payload is always the full {@link PULL_REQUEST_FIELDS} union.
     */
    async view(lookup: GitHubPullRequestLookup): Promise<string | undefined> {
        const reference = lookup.number === undefined ? lookup.branch : String(lookup.number);
        if (!reference) return undefined;
        const slug = `${lookup.owner}/${lookup.repo}`;
        const lookupKey =
            lookup.number === undefined ? `${slug}@${reference}` : `${slug}#${reference}`;
        const cached = this.cached(lookupKey, lookup.maxAgeMs);
        if (cached) return cached.json;
        /**
         * Keyed by lookup shape rather than by repository. Two concurrent first lookups of the same pull request (one
         * by branch, one by number) therefore still spend two queries, because nothing can prove they are the same pull
         * request until one of them answers. Keying by `owner/repo` would coalesce that case, at the price of
         * serialising genuinely different pull requests in one repository, which is exactly what the sidebar sweep does
         * across Sessions. The miss costs one extra query and heals immediately: the answer registers a branch alias
         * onto the record, so every later lookup of either shape joins it.
         */
        try {
            return await this.requests.run(lookupKey, async () => {
                /**
                 * A sibling-key lookup may have produced this record while this call was queued behind the
                 * single-flight, so re-check before spending a query.
                 */
                const settled = this.cached(lookupKey, lookup.maxAgeMs);
                if (settled) return settled.json;
                let json: string | undefined;
                try {
                    const output = await this.runner(
                        'gh',
                        ['pr', 'view', reference, '--repo', slug, '--json', PULL_REQUEST_FIELDS],
                        lookup.cwd,
                    );
                    json = output.trim() || undefined;
                } catch (error) {
                    // Only a confirmed "no pull request" is cacheable. A transport, auth, or quota failure must not be
                    // remembered as absence, or the surfaces would render "no PR" until the TTL expired.
                    if (!isNoPullRequest(error)) throw error;
                }
                this.remember(lookupKey, slug, json);
                return json;
            });
        } catch (error) {
            // Apply the caller's policy after single-flight, so concurrent availability indicators can observe the
            // same failed request that other surfaces are allowed to serve from the last known record.
            if (lookup.allowStaleOnFailure !== false) {
                const stale = this.stored(lookupKey);
                if (stale) return stale.json;
            }
            throw error;
        }
    }

    /**
     * Drops one pull request's record after Caxri changed it on GitHub, so the next read of any shape refetches instead
     * of serving the pre-mutation state. Branch aliases keep pointing at the key and simply miss.
     */
    forget(owner: string, repo: string, number: number): void {
        this.records.delete(`${owner}/${repo}#${number}`);
    }

    clear(): void {
        this.records.clear();
        this.refAliases.clear();
    }
}
