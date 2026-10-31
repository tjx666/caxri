import type { UsageTokenBreakdown } from '@caxri/protocol';

import type { UsageTokens } from './accumulator';
import type { ModelPrice } from './pricing';
import { cacheSavingsOf, costOf } from './pricing';
import type { UsageRecord } from './record';
import { NATIVE_COST_TICKS_PER_USD } from './record';

/**
 * One decoded hour-by-model bucket of a {@link UsageRecord}, priced. The shared unit every usage view folds: the Usage
 * report groups buckets by day, Project, and model, and a per-Session readout can sum them directly.
 */
export interface PricedUsageBucket {
    /**
     * Start of the bucket's hour, epoch milliseconds.
     */
    at: number;
    model: string;
    tokens: UsageTokens;
    /**
     * `input + output + cacheRead + cacheWrite`, the total ccusage reports.
     */
    total: number;
    /**
     * The provider's own cost when it reported one, else the API list-price estimate at the requests' context tier;
     * zero when `isPriced` is false.
     */
    costUsd: number;
    cacheSavingsUsd: number;
    isPriced: boolean;
    /**
     * True when `costUsd` is the provider's own report rather than a list-price estimate.
     */
    isNativeCost: boolean;
}

export type ModelPriceLookup = (model: string) => ModelPrice | undefined;

function totalTokensOf(tokens: UsageTokens): number {
    return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

export function* pricedUsageBuckets(
    record: UsageRecord,
    priceOf: ModelPriceLookup,
): Generator<PricedUsageBucket> {
    for (const [hour, modelIndex, ...values] of record.tokens) {
        const model = record.models[modelIndex] ?? 'unknown';
        const priceClass = { contextFloorK: values[6], serviceTier: values[8] };
        const nativeCostTicks = values[7] ?? undefined;
        const tokens: UsageTokens = {
            input: values[0],
            output: values[1],
            cacheRead: values[2],
            cacheWrite: values[3],
            cacheWrite1h: values[4],
            reasoning: values[5],
        };
        const price = priceOf(model);
        const listCost = price ? costOf(tokens, price, priceClass) : 0;
        yield {
            at: hour * 1000,
            model,
            tokens,
            total: totalTokensOf(tokens),
            costUsd:
                nativeCostTicks === undefined
                    ? listCost
                    : nativeCostTicks / NATIVE_COST_TICKS_PER_USD,
            cacheSavingsUsd: price ? cacheSavingsOf(tokens, price, priceClass) : 0,
            isPriced: price !== undefined || nativeCostTicks !== undefined,
            isNativeCost: nativeCostTicks !== undefined,
        };
    }
}

export function emptyTokenBreakdown(): UsageTokenBreakdown {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

export function addToBreakdown(target: UsageTokenBreakdown, tokens: UsageTokens): void {
    target.input += tokens.input;
    target.output += tokens.output;
    target.cacheRead += tokens.cacheRead;
    target.cacheWrite += tokens.cacheWrite;
    target.reasoning += tokens.reasoning;
    target.total += totalTokensOf(tokens);
}

export interface UsageSummary {
    costUsd: number;
    tokens: UsageTokenBreakdown;
    cacheSavingsUsd: number;
    activeMs: number;
    unpricedModels: string[];
}

/**
 * Totals of one record, optionally from `since` (epoch milliseconds, matched at hour granularity) onward.
 */
export function summarizeUsage(
    record: UsageRecord,
    priceOf: ModelPriceLookup,
    since = 0,
): UsageSummary {
    const summary: UsageSummary = {
        costUsd: 0,
        tokens: emptyTokenBreakdown(),
        cacheSavingsUsd: 0,
        activeMs: 0,
        unpricedModels: [],
    };
    const unpriced = new Set<string>();
    for (const bucket of pricedUsageBuckets(record, priceOf)) {
        if (bucket.at + 3_600_000 <= since) continue;
        summary.costUsd += bucket.costUsd;
        summary.cacheSavingsUsd += bucket.cacheSavingsUsd;
        addToBreakdown(summary.tokens, bucket.tokens);
        if (!bucket.isPriced) unpriced.add(bucket.model);
    }
    for (const [hour, activeMs] of record.activity)
        if (hour * 1000 + 3_600_000 > since) summary.activeMs += activeMs;
    summary.unpricedModels = [...unpriced];
    return summary;
}

/**
 * Sums one Session's ledger records the way the Usage report sums a Session row over all time. `undefined` when the
 * records hold no token usage yet.
 */
export function sessionCostOf(
    records: Iterable<UsageRecord | undefined>,
    priceOf: ModelPriceLookup,
): { costUsd: number; isPartial: boolean } | undefined {
    let costUsd = 0;
    let isPartial = false;
    let hasUsage = false;
    for (const record of records) {
        if (!record) continue;
        for (const bucket of pricedUsageBuckets(record, priceOf)) {
            hasUsage = true;
            costUsd += bucket.costUsd;
            if (!bucket.isPriced) isPartial = true;
        }
    }
    return hasUsage ? { costUsd, isPartial } : undefined;
}
