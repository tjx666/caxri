import type { ProjectStatusAcceptance } from '@caxri/protocol';
import { rememberBounded } from '@caxri/utils';
import type { z } from 'zod';

import { SingleFlight } from '../single-flight';
import { acceptanceBundleSchema, mapAcceptanceBundle, parseExternalJson } from './parse';

/**
 * Longer than the Renderer's 60s status-bar poll, for the reason spelled out on `RECORD_TTL_MS` in `./github.ts`: at
 * exactly 60s every poll lands just past expiry and the shared record is refetched every single time.
 */
const REPORT_TTL_MS = 90_000;
/**
 * A failed lookup is remembered too. Without it, a machine with no `lh` installed would spawn a doomed process once a
 * minute for every open Session, forever.
 */
const FAILURE_TTL_MS = 60_000;
const MAX_REPORT_RECORDS = 128;

/**
 * The bundle's top-level keys the two Caxri surfaces draw, passed to `--json` so the CLI never serializes the parts
 * they do not. The omitted `checks` array grows with every verification round and carries each check's full review
 * trail; pulling it once a minute to render a pass count would be the most expensive field in the response.
 */
const ACCEPTANCE_VIEW_FIELDS = 'acceptance,subject,latestReport,rounds';

export type AcceptanceRunner = (arguments_: readonly string[], cwd: string) => Promise<string>;

export interface AcceptanceLookup {
    cwd: string;
    id: string;
    /**
     * Maximum age the caller accepts. `0` forces a refetch (an explicit user refresh); omitted uses the store's TTL.
     */
    maxAgeMs?: number;
    /**
     * The round the link pinned. It selects which entry of an already-fetched bundle answers, and deliberately does not
     * take part in the cache key: one report is one request no matter how many of its rounds are being watched.
     */
    round?: number;
}

interface BundleRecord {
    bundle?: z.infer<typeof acceptanceBundleSchema>;
    /**
     * Normalized on capture so the replay throws the same shape the first caller saw, not a bare value.
     */
    error?: Error;
    fetchedAt: number;
}

export interface AcceptanceStoreOptions {
    failureTtlMs?: number;
    now?: () => number;
    reportTtlMs?: number;
}

/**
 * The Server's single projection of an acceptance report.
 *
 * Two surfaces read the same reports: the Status panel resolves every report a pull request body names, and the status
 * bar resolves the one it leads with, so a shared record is what keeps a Session's acceptance state from costing two
 * CLI spawns per refresh.
 *
 * Unlike the Linear store there is no allow-list step. An acceptance is addressed by an opaque id that only ever
 * arrives inside a full URL, so a candidate is either a link somebody wrote or nothing at all; there is no cheap
 * ambiguous form to rule on first.
 */
export class AcceptanceStore {
    private readonly bundles = new Map<string, BundleRecord>();
    private readonly requests = new SingleFlight<string, z.infer<typeof acceptanceBundleSchema>>();

    constructor(
        private readonly runner: AcceptanceRunner,
        private readonly options: AcceptanceStoreOptions = {},
    ) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    /**
     * Resolves one report's title, lifecycle status, and the verdict of the round the caller pinned. Throws the
     * underlying CLI failure so a caller that renders a provider error (the Status panel) still can; a caller that
     * degrades silently (the status bar) catches it.
     */
    async report(lookup: AcceptanceLookup): Promise<ProjectStatusAcceptance> {
        const id = lookup.id.toLowerCase();
        const reference = { id, ...(lookup.round && { round: lookup.round }) };
        const cached = this.bundles.get(id);
        if (cached) {
            const ttl =
                lookup.maxAgeMs ??
                (cached.error
                    ? (this.options.failureTtlMs ?? FAILURE_TTL_MS)
                    : (this.options.reportTtlMs ?? REPORT_TTL_MS));
            if (this.now() - cached.fetchedAt < ttl) {
                rememberBounded(this.bundles, id, cached, MAX_REPORT_RECORDS);
                if (cached.error) throw cached.error;
                if (cached.bundle) return mapAcceptanceBundle(cached.bundle, reference);
            }
        }
        const bundle = await this.requests.run(id, async () => {
            try {
                // The id is never passed as the log subject. It names one customer's private acceptance record, and the
                // subject travels into a persisted `warn` record on every failed lookup.
                const raw = await this.runner(
                    ['acceptance', 'view', id, '--json', ACCEPTANCE_VIEW_FIELDS],
                    lookup.cwd,
                );
                const parsed = parseExternalJson(raw, acceptanceBundleSchema, 'acceptance report');
                rememberBounded(
                    this.bundles,
                    id,
                    { bundle: parsed, fetchedAt: this.now() },
                    MAX_REPORT_RECORDS,
                );
                return parsed;
            } catch (error) {
                rememberBounded(
                    this.bundles,
                    id,
                    {
                        error: error instanceof Error ? error : new Error(String(error)),
                        fetchedAt: this.now(),
                    },
                    MAX_REPORT_RECORDS,
                );
                throw error;
            }
        });
        return mapAcceptanceBundle(bundle, reference);
    }
}
