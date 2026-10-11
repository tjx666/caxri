import type { ServiceTier, UsageRecord } from './record';
import { contextFloorK, USAGE_RECORD_VERSION } from './record';

/**
 * Gaps between consecutive transcript records up to this long count as active Agent time; anything longer is the user
 * being away. Five minutes matches the idle cutoff most "active time" trackers use and stays shorter than a typical
 * long-running tool call that still writes progress records.
 */
export const ACTIVE_GAP_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
const MAX_MODELS = 64;
const MAX_PULL_REQUESTS = 64;
/**
 * Bounds the stored unit digests of one transcript; a conversation past it stops deduplicating its newest units.
 */
const MAX_KEYS = 100_000;

export interface UsageTokens {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h: number;
    reasoning: number;
}

export type RateLimitObservation = NonNullable<UsageRecord['rateLimits']>;

export interface UsageDetails {
    /**
     * The request's whole input context (uncached input plus cache reads and writes), which selects a long-context
     * price tier. Omitted for growth of an already filed request.
     */
    contextTokens?: number;
    /**
     * The provider's own cost of these tokens in 10^-10 USD, when it reports one.
     */
    nativeCostTicks?: number;
    /**
     * The processing tier the requests ran at, when not the standard one.
     */
    serviceTier?: ServiceTier;
}

type TokenBucket = UsageRecord['tokens'][number];

function hourStartSeconds(at: number): number {
    return Math.floor(at / HOUR_MS) * 3600;
}

function nonNegative(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Folds parsed transcript records into the persisted {@link UsageRecord} shape: per-hour per-model token buckets,
 * per-hour active time, and the pull requests the Agent created.
 */
export class UsageAccumulator {
    private readonly models = new Map<string, number>();
    private readonly tokens = new Map<string, TokenBucket>();
    private readonly keys: string[] = [];
    private readonly activity = new Map<number, number>();
    private readonly pullRequests = new Set<string>();
    private previousActivityAt?: number;
    private firstAt?: number;
    private lastAt?: number;
    private rateLimits?: RateLimitObservation;
    bornAt?: number;

    private observe(at: number): void {
        if (this.firstAt === undefined || at < this.firstAt) this.firstAt = at;
        if (this.lastAt === undefined || at > this.lastAt) this.lastAt = at;
    }

    addUsage(at: number, model: string, usage: UsageTokens, details: UsageDetails = {}): void {
        const values = [
            usage.input,
            usage.output,
            usage.cacheRead,
            usage.cacheWrite,
            usage.cacheWrite1h,
            usage.reasoning,
        ].map(nonNegative);
        if (values.every((value) => value === 0)) return;
        let modelIndex = this.models.get(model);
        if (modelIndex === undefined) {
            if (this.models.size >= MAX_MODELS) return;
            modelIndex = this.models.size;
            this.models.set(model, modelIndex);
        }
        const hour = hourStartSeconds(at);
        const floor = contextFloorK(details.contextTokens ?? 0);
        const { nativeCostTicks, serviceTier } = details;
        const isNative = nativeCostTicks !== undefined;
        const key = `${hour}:${modelIndex}:${floor}:${isNative ? 1 : 0}:${serviceTier ?? ''}`;
        let bucket = this.tokens.get(key);
        if (!bucket) {
            const counts = [hour, modelIndex, 0, 0, 0, 0, 0, 0, floor] as const;
            if (serviceTier) bucket = [...counts, isNative ? 0 : null, serviceTier];
            else if (isNative) bucket = [...counts, 0];
            else bucket = [...counts];
            this.tokens.set(key, bucket);
        }
        // Positions 2 to 7 are the token counts, numbers in every bucket shape.
        const counts = bucket as number[];
        for (const [offset, value] of values.entries()) counts[offset + 2] += value;
        if (isNative) bucket[9] = (bucket[9] ?? 0) + nonNegative(nativeCostTicks);
        this.observe(at);
    }

    /**
     * Feeds one record timestamp of a single chronological stream. Call {@link endStream} before feeding another file so
     * the gap between two files never counts as activity.
     */
    markActivity(at: number): void {
        if (!Number.isFinite(at) || at <= 0) return;
        this.observe(at);
        const previous = this.previousActivityAt;
        if (previous !== undefined) {
            const gap = at - previous;
            if (gap > 0 && gap <= ACTIVE_GAP_MS) {
                const hour = hourStartSeconds(previous);
                this.activity.set(hour, (this.activity.get(hour) ?? 0) + gap);
            }
        }
        if (previous === undefined || at > previous) this.previousActivityAt = at;
    }

    endStream(): void {
        this.previousActivityAt = undefined;
    }

    /**
     * Records the digest of one billed unit of the main transcript, whether or not this transcript counts it.
     */
    addKey(digest: string): void {
        if (this.keys.length < MAX_KEYS) this.keys.push(digest);
    }

    addPullRequest(url: string): void {
        if (this.pullRequests.size < MAX_PULL_REQUESTS) this.pullRequests.add(url);
    }

    observeRateLimits(observation: RateLimitObservation): void {
        if (!this.rateLimits || observation.observedAt >= this.rateLimits.observedAt)
            this.rateLimits = observation;
    }

    toRecord(): UsageRecord {
        return {
            version: USAGE_RECORD_VERSION,
            models: this.models.keys().toArray(),
            tokens: this.tokens
                .values()
                .toArray()
                .toSorted(
                    (a, b) =>
                        a[0] - b[0] ||
                        a[1] - b[1] ||
                        a[8] - b[8] ||
                        a.length - b.length ||
                        (a[10] ?? '').localeCompare(b[10] ?? ''),
                ),
            activity: this.activity
                .entries()
                .map(([hour, ms]): [number, number] => [hour, Math.round(ms)])
                .toArray()
                .toSorted((a, b) => a[0] - b[0]),
            firstAt: this.firstAt,
            lastAt: this.lastAt,
            pullRequests: [...this.pullRequests],
            rateLimits: this.rateLimits,
            ...(this.keys.length > 0 && { keys: [...this.keys] }),
            ...(this.bornAt !== undefined && { bornAt: Math.trunc(this.bornAt) }),
        };
    }
}
