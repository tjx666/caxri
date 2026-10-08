import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { z } from 'zod';

import { atomicWrite } from '../atomic-file';
import type { ExternalStatusQuotaSource } from './command';
import { ExternalStatusCliError, isSecondaryRateLimit } from './command';

/**
 * GraphQL points deliberately left unspent by Caxri's own polling. The same GitHub account runs the user's shell, the
 * Agent's `gh` calls, and editor extensions; a desktop app that drains the budget to zero breaks all of them, which is
 * exactly the failure this limiter exists to prevent.
 */
const GITHUB_POINT_RESERVE = 100;
/**
 * GitHub's secondary (abuse) limit clears in seconds rather than at the hourly primary reset.
 */
const SECONDARY_PAUSE_MS = 60_000;
/**
 * Used when the quota probe cannot report a GraphQL reset. GitHub's primary window is one hour, so this errs short and
 * lets the next failure re-pause rather than idling delivery metadata for an hour on a misread.
 */
const GITHUB_FALLBACK_PAUSE_MS = 15 * 60_000;
/**
 * Neither the Linear nor the Vercel CLI reports a reset time, so their circuits back off geometrically instead and
 * reset on the first success.
 */
const BACKOFF_LADDER_MS = [60_000, 120_000, 300_000, 900_000];
const MAX_PAUSE_MS = 60 * 60_000;
/**
 * Parallel worktree Servers, and a second Caxri window, share one pause file so a limit one of them hit is not
 * rediscovered by every sibling. Re-read it at most this often to keep the hot path off the filesystem.
 */
const PAUSE_RELOAD_MS = 5_000;
/**
 * The probe is a GraphQL query whose only field is `rateLimit`. GitHub does not bill such a query, so twelve probes an
 * hour spend none of the budget they protect (measured in #917: interleaved probes left `used` unchanged).
 */
const QUOTA_PROBE_INTERVAL_MS = 5 * 60_000;

/**
 * Every quota-governed source, spelled out so the shared pause file is read back for all of them. The `Record` key type
 * makes a source added to {@link ExternalStatusQuotaSource} and forgotten here a compile error rather than a circuit
 * that silently stops honouring a sibling Server's pause.
 */
const QUOTA_SOURCES = Object.keys({
    gh: true,
    lh: true,
    linear: true,
    vc: true,
} satisfies Record<ExternalStatusQuotaSource, true>) as readonly ExternalStatusQuotaSource[];

const pauseEntrySchema = z.object({ resumeAt: z.number() });

const pauseFileSchema = z.object({
    sources: z.record(z.string(), pauseEntrySchema).optional(),
});

const graphqlBudgetSchema = z.object({
    limit: z.number().optional(),
    remaining: z.number(),
    /**
     * ISO 8601 timestamp, per the GraphQL `RateLimit` object.
     */
    resetAt: z.string(),
    used: z.number().optional(),
});

const githubRateLimitSchema = z.object({
    data: z.object({ rateLimit: graphqlBudgetSchema.nullable().optional() }).optional(),
});

export interface GitHubQuota {
    remaining: number;
    resetAt: number;
}

interface SourceCircuit {
    /**
     * Consecutive rate-limit failures; indexes {@link BACKOFF_LADDER_MS} for the sources with no reported reset.
     */
    failures: number;
    resumeAt: number;
}

export interface ExternalStatusLimiterOptions {
    logger?: StructuredLogger;
    now?: () => number;
    /**
     * Overridden in tests; production writes under the user cache directory so sibling Servers observe the same pause.
     */
    pausePath?: string;
    /**
     * Reads GitHub's GraphQL budget. Must bypass this limiter: it is the probe that decides whether to pause.
     */
    probeQuota?: () => Promise<GitHubQuota | undefined>;
    reloadIntervalMs?: number;
}

function defaultExternalStatusPausePath(): string {
    return join(homedir(), '.cache', 'caxri', 'external-status-limit.json');
}

/**
 * One circuit breaker per external source. A rate-limited `gh` call pauses only `gh`, until the reset GitHub itself
 * reports, and the pause is durable across processes: the previous behaviour retried every thirty seconds from four
 * independent call sites, which is what kept the account limited instead of letting it recover.
 */
export class ExternalStatusLimiter {
    private readonly circuits = new Map<ExternalStatusQuotaSource, SourceCircuit>();
    /**
     * When the quota probe last _ran_, as opposed to when it last produced a reading. A CLI that cannot report a
     * GraphQL budget (unauthenticated, proxied, or stubbed) would otherwise be re-probed before every single request,
     * silently doubling the `gh` spawns this limiter exists to reduce.
     */
    private lastProbeAt = 0;
    private lastReloadAt = 0;
    private pendingReload?: Promise<void>;
    private quota?: GitHubQuota & { probedAt: number };
    private readonly pausePath: string;
    private readonly reloadIntervalMs: number;

    constructor(private readonly options: ExternalStatusLimiterOptions = {}) {
        this.pausePath = options.pausePath ?? defaultExternalStatusPausePath();
        this.reloadIntervalMs = options.reloadIntervalMs ?? PAUSE_RELOAD_MS;
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private circuit(source: ExternalStatusQuotaSource): SourceCircuit {
        const existing = this.circuits.get(source);
        if (existing) return existing;
        const created: SourceCircuit = { failures: 0, resumeAt: 0 };
        this.circuits.set(source, created);
        return created;
    }

    /**
     * Keeps a reserve of GraphQL points for everything else the user's GitHub account is doing. Probing on the request
     * path rather than on a timer means an idle Caxri spends nothing at all.
     */
    private async ensureGitHubQuota(): Promise<void> {
        const probe = this.options.probeQuota;
        if (!probe) return;
        const now = this.now();
        if (
            this.quota &&
            this.quota.resetAt > now &&
            this.quota.probedAt + QUOTA_PROBE_INTERVAL_MS > now
        )
            return;
        if (this.lastProbeAt !== 0 && this.lastProbeAt + QUOTA_PROBE_INTERVAL_MS > now) return;
        this.lastProbeAt = now;
        let reading: GitHubQuota | undefined;
        try {
            reading = await probe();
        } catch {
            // A failed probe must never block delivery metadata: fall through and let the real call report the limit.
            return;
        }
        if (!reading) return;
        this.quota = { ...reading, probedAt: this.now() };
        this.options.logger?.write('debug', logEventCatalog.externalStatus.quota, {
            fields: { source: 'gh', remaining: reading.remaining },
        });
        if (reading.remaining > GITHUB_POINT_RESERVE) return;
        await this.pauseUntil('gh', reading.resetAt, 'reserve');
    }

    private async open(source: ExternalStatusQuotaSource, message: string): Promise<void> {
        const circuit = this.circuit(source);
        circuit.failures += 1;
        if (source === 'gh' && isSecondaryRateLimit(message)) {
            await this.pauseUntil(source, this.now() + SECONDARY_PAUSE_MS, 'secondary');
            return;
        }
        if (source === 'gh') {
            let resetAt: number | undefined;
            try {
                const reading = await this.options.probeQuota?.();
                if (reading) {
                    this.quota = { ...reading, probedAt: this.now() };
                    resetAt = reading.resetAt;
                }
            } catch {
                // Probe failure falls through to the fixed fallback below.
            }
            await this.pauseUntil(
                source,
                resetAt ?? this.now() + GITHUB_FALLBACK_PAUSE_MS,
                'primary',
            );
            return;
        }
        const step = Math.min(circuit.failures - 1, BACKOFF_LADDER_MS.length - 1);
        await this.pauseUntil(source, this.now() + BACKOFF_LADDER_MS[step], 'backoff');
    }

    private async pauseUntil(
        source: ExternalStatusQuotaSource,
        resumeAt: number,
        reason: 'backoff' | 'primary' | 'reserve' | 'secondary',
    ): Promise<void> {
        const now = this.now();
        const bounded = Math.min(Math.max(resumeAt, now), now + MAX_PAUSE_MS);
        const circuit = this.circuit(source);
        if (bounded <= circuit.resumeAt) return;
        circuit.resumeAt = bounded;
        this.options.logger?.write('warn', logEventCatalog.externalStatus.paused, {
            fields: { source, reason, pauseMs: bounded - now },
        });
        await this.persist();
    }

    /**
     * Reads the shared pause file. An absent, unreadable, or malformed file is indistinguishable from "nobody has
     * recorded a pause": the circuits are still enforced in-process, so no caller needs to hear about it.
     */
    private async readSharedPauses(): Promise<Partial<Record<ExternalStatusQuotaSource, number>>> {
        let contents: string;
        try {
            contents = await readFile(this.pausePath, 'utf8');
        } catch {
            return {};
        }
        let parsed: z.infer<typeof pauseFileSchema>;
        try {
            parsed = pauseFileSchema.parse(JSON.parse(contents));
        } catch {
            return {};
        }
        const pauses: Partial<Record<ExternalStatusQuotaSource, number>> = {};
        for (const name of QUOTA_SOURCES) {
            const resumeAt = parsed.sources?.[name]?.resumeAt;
            if (typeof resumeAt === 'number') pauses[name] = resumeAt;
        }
        return pauses;
    }

    /**
     * Merges the shared pause file into this process's circuits. Only the later resume time survives, so a sibling
     * Server that learned a longer pause is always honoured.
     */
    private async reload(): Promise<void> {
        if (this.pendingReload) {
            await this.pendingReload;
            return;
        }
        const now = this.now();
        if (this.lastReloadAt !== 0 && this.lastReloadAt + this.reloadIntervalMs > now) return;
        this.lastReloadAt = now;
        this.pendingReload = (async () => {
            const shared = await this.readSharedPauses();
            for (const name of QUOTA_SOURCES) {
                const resumeAt = shared[name];
                if (resumeAt === undefined) continue;
                const circuit = this.circuit(name);
                circuit.resumeAt = Math.min(
                    Math.max(circuit.resumeAt, resumeAt),
                    this.now() + MAX_PAUSE_MS,
                );
            }
        })();
        try {
            await this.pendingReload;
        } finally {
            this.pendingReload = undefined;
        }
    }

    /**
     * Re-reads the shared file and writes back the per-source maximum. A blind overwrite would erase a pause a sibling
     * Server recorded for a _different_ source inside this process's reload window: that Server keeps honouring its own
     * pause, but every newly started Server would read a file that no longer mentions it and spend a request
     * rediscovering a limit the pause file exists to broadcast. The merge is not atomic across processes; it narrows
     * the lost-update window to the read-write pair rather than the whole reload interval, which is all a best-effort
     * hint needs.
     */
    private async persist(): Promise<void> {
        const shared = await this.readSharedPauses();
        const sources: Record<string, { resumeAt: number }> = {};
        for (const name of QUOTA_SOURCES) {
            const circuit = this.circuit(name);
            const resumeAt = Math.max(circuit.resumeAt, shared[name] ?? 0);
            if (resumeAt <= this.now()) continue;
            sources[name] = { resumeAt };
            // Adopt a sibling's longer pause immediately rather than waiting for the next reload window.
            circuit.resumeAt = Math.min(resumeAt, this.now() + MAX_PAUSE_MS);
        }
        try {
            await atomicWrite(this.pausePath, `${JSON.stringify({ sources })}\n`);
        } catch {
            // The pause is still enforced in-process; losing the cross-process hint is not worth failing a request.
        }
    }

    /**
     * Milliseconds left on `source`'s pause, or zero when the circuit is closed.
     */
    pauseRemainingMs(source: ExternalStatusQuotaSource): number {
        return Math.max(0, this.circuit(source).resumeAt - this.now());
    }

    /**
     * Runs `work` only while `source`'s circuit is closed, and opens that circuit when the provider reports a limit. A
     * paused source fails immediately with the same `rate-limited` error kind the CLI would have produced, so every
     * consumer keeps rendering its last good snapshot instead of learning a new failure mode.
     */
    async guard<T>(source: ExternalStatusQuotaSource, work: () => Promise<T>): Promise<T> {
        await this.reload();
        if (source === 'gh') await this.ensureGitHubQuota();
        const remaining = this.pauseRemainingMs(source);
        if (remaining > 0) {
            const paused = new ExternalStatusCliError(
                source,
                'rate-limited',
                `${source}: rate limited, paused for ${Math.ceil(remaining / 1_000)}s`,
            );
            paused.retryAt = this.circuit(source).resumeAt;
            throw paused;
        }
        try {
            const result = await work();
            const circuit = this.circuit(source);
            if (circuit.failures > 0) {
                circuit.failures = 0;
                this.options.logger?.write('info', logEventCatalog.externalStatus.resumed, {
                    fields: { source },
                });
            }
            return result;
        } catch (error) {
            if (error instanceof ExternalStatusCliError && error.kind === 'rate-limited') {
                await this.open(source, error.message);
                // The provider reported the limit; the circuit now holds the deadline the UI needs to state.
                error.retryAt = this.circuit(source).resumeAt;
            }
            throw error;
        }
    }
}

/**
 * Parses the `GITHUB_RATE_LIMIT_QUERY` response into the GraphQL budget. Returns `undefined` for malformed JSON, a
 * response without `data.rateLimit` (an unauthenticated or proxied CLI), or a `resetAt` that does not parse: the caller
 * treats every one of those as "no reading" and never pauses on it. The REST `/rate_limit` shape the probe used to read
 * is rejected the same way rather than parsed into a placeholder value.
 */
export function parseGitHubRateLimit(output: string): GitHubQuota | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(output);
    } catch {
        return undefined;
    }
    const result = githubRateLimitSchema.safeParse(parsed);
    const rateLimit = result.success ? result.data.data?.rateLimit : undefined;
    if (!rateLimit) return undefined;
    const resetAt = Date.parse(rateLimit.resetAt);
    return Number.isNaN(resetAt) ? undefined : { remaining: rateLimit.remaining, resetAt };
}
