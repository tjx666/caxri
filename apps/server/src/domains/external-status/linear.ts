import type { ProjectStatusLinearIssue } from '@caxri/protocol';
import { rememberBounded } from '@caxri/utils';
import { z } from 'zod';

import { SingleFlight } from '../single-flight';
import {
    LINEAR_ISSUE_QUERY,
    linearIssueResponseSchema,
    mapLinearIssue,
    parseExternalJson,
} from './parse';

/**
 * Deliberately longer than the Renderer's 60s status-bar poll, for the reason spelled out on `RECORD_TTL_MS` in
 * `./github.ts`: at exactly 60s every poll lands just past expiry and the shared record is refetched every single
 * time.
 */
const ISSUE_TTL_MS = 90_000;
/**
 * A failed lookup is remembered too. Without it, a machine with no `linear` CLI installed would spawn a doomed process
 * once a minute for every open Session, forever.
 */
const FAILURE_TTL_MS = 60_000;
/**
 * A workspace's team keys are effectively static — a new team is created a handful of times in a product's life — and
 * this is the allow-list that decides whether a bare `ABC-123` in a branch name or a conversation is a real issue. One
 * query per workspace per six hours buys that decision for every Session.
 */
const TEAM_KEYS_TTL_MS = 6 * 60 * 60_000;
const TEAM_KEYS_FAILURE_TTL_MS = 5 * 60_000;
const MAX_ISSUE_RECORDS = 256;
const MAX_TEAM_KEY_RECORDS = 32;

/**
 * https://linear.app/developers/graphql — `teams` is readable with the same scope the issue query already needs.
 */
export const LINEAR_TEAM_KEYS_QUERY = 'query TeamKeys{teams(first:250){nodes{key}}}';

const teamNodeSchema = z.object({ key: z.string() });
const teamsSchema = z.object({ nodes: z.array(teamNodeSchema).optional() });
const teamKeysResponseSchema = z.object({
    data: z.object({ teams: teamsSchema.optional() }).optional(),
});

export type LinearRunner = (
    arguments_: readonly string[],
    cwd: string,
    subject?: string,
) => Promise<string>;

export interface LinearIssueLookup {
    cwd: string;
    identifier: string;
    /**
     * Whether the identifier came from a source the user deliberately wrote, which is the only case where it may reach
     * the structured command log. A marker harvested from an Agent transcript must not: `diagnostics.ts` excludes
     * transcript content, and the subject travels into a persisted `warn` record on every failed lookup.
     */
    isStated?: boolean;
    /**
     * Maximum age the caller accepts. `0` forces a refetch (an explicit user refresh); omitted uses the store's TTL.
     */
    maxAgeMs?: number;
    workspace?: string;
}

interface IssueRecord {
    /**
     * Normalized on capture so the replay throws the same shape the first caller saw, not a bare value.
     */
    error?: Error;
    fetchedAt: number;
    issue?: ProjectStatusLinearIssue;
}

interface TeamKeyRecord {
    fetchedAt: number;
    keys: ReadonlySet<string>;
    ok: boolean;
}

export interface LinearIssueStoreOptions {
    failureTtlMs?: number;
    issueTtlMs?: number;
    now?: () => number;
    teamKeysTtlMs?: number;
}

/**
 * The Server's single projection of a Linear issue, and the single owner of the workspace's team-key allow-list.
 *
 * Two surfaces read the same issues — the Status panel resolves every reference a pull request body names, and the
 * status bar resolves the one issue it leads with — so a shared record is what keeps a Session's Linear state from
 * costing two CLI spawns per refresh.
 *
 * The allow-list exists because the cheap sources of an issue identifier are also the ambiguous ones. An `ABC-42`
 * lifted out of a branch name or a conversation is indistinguishable in shape from `UTF-8`, `RFC-2119`, or `CVE-2024`.
 * Asking Linear about each candidate would spend a query to learn that a text encoding is not an issue; asking once
 * which team keys exist settles every candidate for free, and settles them correctly.
 */
export class LinearIssueStore {
    private readonly issues = new Map<string, IssueRecord>();
    private readonly issueRequests = new SingleFlight<string, ProjectStatusLinearIssue>();
    private readonly teamKeys = new Map<string, TeamKeyRecord>();
    private readonly teamKeyRequests = new SingleFlight<string, ReadonlySet<string>>();

    constructor(
        private readonly runner: LinearRunner,
        private readonly options: LinearIssueStoreOptions = {},
    ) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    /**
     * The team keys this repository's Linear workspace defines, upper-cased. An unavailable CLI yields an empty set
     * rather than an error: callers use it to _narrow_ candidates, so "unknown" must never widen what is shown.
     */
    async allowedTeamKeys(cwd: string): Promise<ReadonlySet<string>> {
        const cached = this.teamKeys.get(cwd);
        const ttl = cached?.ok
            ? (this.options.teamKeysTtlMs ?? TEAM_KEYS_TTL_MS)
            : TEAM_KEYS_FAILURE_TTL_MS;
        if (cached && this.now() - cached.fetchedAt < ttl) {
            rememberBounded(this.teamKeys, cwd, cached, MAX_TEAM_KEY_RECORDS);
            return cached.keys;
        }
        return this.teamKeyRequests.run(cwd, async () => {
            let keys: ReadonlySet<string> = new Set();
            let isOk = false;
            try {
                const parsed = parseExternalJson(
                    await this.runner(['api', LINEAR_TEAM_KEYS_QUERY], cwd, 'team keys'),
                    teamKeysResponseSchema,
                    'Linear team keys',
                );
                keys = new Set(
                    (parsed.data?.teams?.nodes ?? []).map((team) => team.key.toUpperCase()),
                );
                isOk = true;
            } catch {
                // A missing CLI, an unauthenticated workspace, or a paused quota all mean the same thing here: no
                // allow-list, so no bare marker is trusted. Never an error the caller has to render.
            }
            rememberBounded(
                this.teamKeys,
                cwd,
                { fetchedAt: this.now(), keys, ok: isOk },
                MAX_TEAM_KEY_RECORDS,
            );
            return keys;
        });
    }

    /**
     * Resolves one issue's title, workflow state, and URL. Throws the underlying CLI failure so a caller that renders a
     * provider error (the Status panel) still can; a caller that degrades silently (the status bar) catches it.
     */
    async issue(lookup: LinearIssueLookup): Promise<ProjectStatusLinearIssue> {
        const identifier = lookup.identifier.toUpperCase();
        const key = `${lookup.workspace?.toLowerCase() ?? ''}\0${identifier}`;
        const cached = this.issues.get(key);
        if (cached) {
            const ttl =
                lookup.maxAgeMs ??
                (cached.error
                    ? (this.options.failureTtlMs ?? FAILURE_TTL_MS)
                    : (this.options.issueTtlMs ?? ISSUE_TTL_MS));
            if (this.now() - cached.fetchedAt < ttl) {
                rememberBounded(this.issues, key, cached, MAX_ISSUE_RECORDS);
                if (cached.error) throw cached.error;
                if (cached.issue) return cached.issue;
            }
        }
        return this.issueRequests.run(key, async () => {
            const arguments_ = ['api', LINEAR_ISSUE_QUERY, '--variable', `id=${identifier}`];
            if (lookup.workspace) arguments_.push('--workspace', lookup.workspace);
            try {
                const raw = parseExternalJson(
                    await this.runner(
                        arguments_,
                        lookup.cwd,
                        lookup.isStated ? identifier : 'issue',
                    ),
                    linearIssueResponseSchema,
                    'Linear issue',
                );
                const issue = mapLinearIssue(raw, identifier);
                rememberBounded(
                    this.issues,
                    key,
                    { fetchedAt: this.now(), issue },
                    MAX_ISSUE_RECORDS,
                );
                return issue;
            } catch (error) {
                rememberBounded(
                    this.issues,
                    key,
                    {
                        error: error instanceof Error ? error : new Error(String(error)),
                        fetchedAt: this.now(),
                    },
                    MAX_ISSUE_RECORDS,
                );
                throw error;
            }
        });
    }

    clear(): void {
        this.issues.clear();
        this.teamKeys.clear();
    }
}
