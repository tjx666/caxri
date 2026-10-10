import type { UsageRecord } from './record';
import { USAGE_RECORD_VERSION } from './record';

/**
 * Gaps between consecutive transcript records up to this long count as active Agent time; anything longer is the user
 * being away. Five minutes matches the idle cutoff most "active time" trackers use and stays shorter than a typical
 * long-running tool call that still writes progress records.
 */
export const ACTIVE_GAP_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
const MAX_MODELS = 64;
const MAX_PULL_REQUESTS = 64;

export interface UsageTokens {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h: number;
    reasoning: number;
}

export type RateLimitObservation = NonNullable<UsageRecord['rateLimits']>;

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
    private readonly tokens = new Map<string, UsageRecord['tokens'][number]>();
    private readonly activity = new Map<number, number>();
    private readonly pullRequests = new Set<string>();
    private previousActivityAt?: number;
    private firstAt?: number;
    private lastAt?: number;
    private rateLimits?: RateLimitObservation;

    private observe(at: number): void {
        if (this.firstAt === undefined || at < this.firstAt) this.firstAt = at;
        if (this.lastAt === undefined || at > this.lastAt) this.lastAt = at;
    }

    addUsage(at: number, model: string, usage: UsageTokens): void {
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
        const key = `${hour}:${modelIndex}`;
        const bucket = this.tokens.get(key) ?? [hour, modelIndex, 0, 0, 0, 0, 0, 0];
        for (const [offset, value] of values.entries()) bucket[offset + 2] += value;
        this.tokens.set(key, bucket);
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
                .toSorted((a, b) => a[0] - b[0] || a[1] - b[1]),
            activity: this.activity
                .entries()
                .map(([hour, ms]): [number, number] => [hour, Math.round(ms)])
                .toArray()
                .toSorted((a, b) => a[0] - b[0]),
            firstAt: this.firstAt,
            lastAt: this.lastAt,
            pullRequests: [...this.pullRequests],
            rateLimits: this.rateLimits,
        };
    }
}
