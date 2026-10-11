import { describe, expect, it } from 'vitest';

import type { ModelPrice } from '../pricing';
import type { UsageRecord } from '../record';
import { summarizeUsage } from '../summary';

const HOUR_SECONDS = 1_700_000_000 - (1_700_000_000 % 3600);
const PRICE: ModelPrice = [1e-6, 2e-6, 1e-7, 1.25e-6, 2e-6];

const record: UsageRecord = {
    version: 2,
    models: ['priced', 'unpriced'],
    tokens: [
        [HOUR_SECONDS, 0, 100, 10, 1000, 50, 20, 0, 0],
        [HOUR_SECONDS + 3600, 1, 5, 5, 0, 0, 0, 2, 0],
    ],
    activity: [
        [HOUR_SECONDS, 1000],
        [HOUR_SECONDS + 3600, 2000],
    ],
    pullRequests: [],
};

describe('summarizeUsage', () => {
    it('totals tokens, cost, cache savings, and active time', () => {
        const summary = summarizeUsage(record, (model) => (model === 'priced' ? PRICE : undefined));

        expect(summary.tokens).toEqual({
            input: 105,
            output: 15,
            cacheRead: 1000,
            cacheWrite: 50,
            reasoning: 2,
            total: 1170,
        });
        // 100 input + 10 output + 1000 cache reads + 30 five-minute writes + 20 one-hour writes.
        expect(summary.costUsd).toBeCloseTo(100e-6 + 20e-6 + 100e-6 + 37.5e-6 + 40e-6);
        expect(summary.cacheSavingsUsd).toBeCloseTo(1000 * 0.9e-6);
        expect(summary.activeMs).toBe(3000);
        expect(summary.unpricedModels).toEqual(['unpriced']);
    });

    it('starts from the hour containing `since`', () => {
        const summary = summarizeUsage(record, () => PRICE, (HOUR_SECONDS + 3600) * 1000 + 1);

        expect(summary.tokens.total).toBe(10);
        expect(summary.activeMs).toBe(2000);
    });

    it('prefers the provider-reported cost and prices the rest at their context and processing tier', () => {
        const tiered: ModelPrice = [
            1e-6,
            2e-6,
            1e-7,
            1.25e-6,
            2e-6,
            { tiers: [[200, 2e-6, 4e-6, 2e-7, 2.5e-6, 4e-6]], serviceTiers: { priority: 2 } },
        ];
        const summary = summarizeUsage(
            {
                ...record,
                models: ['tiered', 'unpriced'],
                tokens: [
                    [HOUR_SECONDS, 0, 100, 0, 0, 0, 0, 0, 128],
                    [HOUR_SECONDS, 0, 100, 0, 0, 0, 0, 0, 200],
                    [HOUR_SECONDS, 0, 100, 0, 0, 0, 0, 0, 0, null, 'priority'],
                    // 0.5 USD in ticks of 1e-10 USD, from a model the price list does not know.
                    [HOUR_SECONDS, 1, 100, 0, 0, 0, 0, 0, 0, 5e9],
                ],
            },
            (model) => (model === 'tiered' ? tiered : undefined),
        );

        expect(summary.costUsd).toBeCloseTo(100e-6 + 200e-6 + 200e-6 + 0.5);
        expect(summary.unpricedModels).toEqual([]);
    });
});
