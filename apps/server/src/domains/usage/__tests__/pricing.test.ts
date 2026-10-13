import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ModelPrice } from '../pricing';
import {
    cacheSavingsOf,
    cacheWritePrice,
    costOf,
    estimateCacheRewriteUsd,
    modelPriceCandidates,
    ModelPricing,
    offlinePriceListFetch,
    projectLiteLlmPrices,
    ratesFor,
} from '../pricing';

async function userDataPath() {
    const path = await mkdtemp(join(tmpdir(), 'caxri-usage-pricing-'));
    onTestFinished(() => rm(path, { recursive: true, force: true }));
    return path;
}

describe('modelPriceCandidates', () => {
    it('tries the exact name, provider prefixes, the undated name, then shorter variants', () => {
        const candidates = modelPriceCandidates('grok-4.7-build-20260101');

        expect(candidates.slice(0, 2)).toEqual([
            'grok-4.7-build-20260101',
            'anthropic/grok-4.7-build-20260101',
        ]);
        expect(candidates).toContain('grok-4.7-build');
        expect(candidates).toContain('xai/grok-4.7');
        expect(candidates).not.toContain('grok');
    });
});

describe('projectLiteLlmPrices', () => {
    it('keeps priced entries and skips the rest', () => {
        expect(
            projectLiteLlmPrices({
                'sample_spec': { max_tokens: 1 },
                'model-a': {
                    input_cost_per_token: 1e-6,
                    output_cost_per_token: 2e-6,
                    cache_read_input_token_cost: 1e-7,
                },
            }),
        ).toEqual({ 'model-a': [1e-6, 2e-6, 1e-7, null, null] });
    });

    it('keeps long-context tiers at thresholds the record can resolve, filling missing rates from the base', () => {
        expect(
            projectLiteLlmPrices({
                'model-b': {
                    input_cost_per_token: 3e-6,
                    output_cost_per_token: 15e-6,
                    cache_read_input_token_cost: 3e-7,
                    input_cost_per_token_above_200k_tokens: 6e-6,
                    output_cost_per_token_above_200k_tokens: 22.5e-6,
                    // 300k is not a context floor the usage record stores, so it cannot be applied.
                    input_cost_per_token_above_300k_tokens: 9e-6,
                    input_cost_per_token_above_200k_tokens_priority: 12e-6,
                    input_cost_per_token_priority: 12e-6,
                },
            }),
        ).toEqual({
            'model-b': [
                3e-6,
                15e-6,
                3e-7,
                null,
                null,
                {
                    tiers: [[200, 6e-6, 22.5e-6, 3e-7, null, null]],
                    serviceTiers: { priority: 4 },
                },
            ],
        });
    });
});

describe('long-context pricing', () => {
    const tiered: ModelPrice = [
        1e-6,
        2e-6,
        1e-7,
        null,
        null,
        { tiers: [[200, 2e-6, 3e-6, 2e-7, null, null]], serviceTiers: { priority: 2 } },
    ];
    const tokens = {
        input: 10,
        output: 10,
        cacheRead: 100,
        cacheWrite: 0,
        cacheWrite1h: 0,
        reasoning: 0,
    };

    it('bills a whole request at the tier its context exceeded', () => {
        expect(ratesFor(tiered, 128)).toEqual([1e-6, 2e-6, 1e-7, null, null]);
        expect(ratesFor(tiered, 200)).toEqual([2e-6, 3e-6, 2e-7, null, null]);
        expect(ratesFor(tiered, 1000)).toEqual([2e-6, 3e-6, 2e-7, null, null]);
        expect(costOf(tokens, tiered)).toBeCloseTo(10e-6 + 20e-6 + 10e-6);
        expect(costOf(tokens, tiered, { contextFloorK: 256 })).toBeCloseTo(20e-6 + 30e-6 + 20e-6);
        expect(cacheSavingsOf(tokens, tiered, { contextFloorK: 256 })).toBeCloseTo(100 * 1.8e-6);
    });

    it('scales a priority request by the multiplier the list states, and leaves an unknown tier at list price', () => {
        expect(costOf(tokens, tiered, { serviceTier: 'priority' })).toBeCloseTo(2 * 40e-6);
        expect(costOf(tokens, tiered, { contextFloorK: 272, serviceTier: 'priority' })).toBeCloseTo(
            2 * 70e-6,
        );
        expect(costOf(tokens, tiered, { serviceTier: 'flex' })).toBeCloseTo(40e-6);
    });
});

describe('ModelPricing', () => {
    it('drops a price list larger than the cap without buffering it whole', async () => {
        const path = await userDataPath();
        let pulled = 0;
        const chunk = new Uint8Array(1024 * 1024).fill(0x20);
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 1;
                controller.enqueue(chunk);
            },
        });
        const pricing = new ModelPricing({
            userDataPath: path,
            fetch: () => Promise.resolve(new Response(body)),
            now: () => 1000,
        });
        await pricing.ensureFresh();

        expect(pricing.source).toBe('bundled');
        expect(pulled).toBeLessThanOrEqual(18);
    });

    it('serves the bundled list without a network call under the E2E fetch', async () => {
        const pricing = new ModelPricing({
            userDataPath: await userDataPath(),
            fetch: offlinePriceListFetch,
            now: () => 1000,
        });
        await pricing.ensureFresh();
        expect(pricing.source).toBe('bundled');
    });

    it('refreshes from the network once, caches the list, and reuses the cache', async () => {
        const path = await userDataPath();
        const fetch = vi.fn(() =>
            Promise.resolve(
                Response.json({ 'model-a': { input_cost_per_token: 3, output_cost_per_token: 4 } }),
            ),
        );
        const pricing = new ModelPricing({ userDataPath: path, fetch, now: () => 1000 });
        await Promise.all([pricing.ensureFresh(), pricing.ensureFresh()]);

        expect(fetch).toHaveBeenCalledOnce();
        expect(pricing.source).toBe('remote');
        expect(pricing.priceOf('anthropic/model-a-20260101')).toBeUndefined();
        expect(pricing.priceOf('model-a-20260101')).toEqual([3, 4, null, null, null]);
        const cached = await readFile(join(path, 'usage', 'model-prices.json'), 'utf8');
        expect(JSON.parse(cached)).toMatchObject({ fetchedAt: 1000 });

        const second = new ModelPricing({ userDataPath: path, fetch, now: () => 2000 });
        await second.ensureFresh();
        expect(fetch).toHaveBeenCalledOnce();
        expect(second.source).toBe('cache');
    });

    it('refetches a cache written before the projection gained tiers', async () => {
        const path = await userDataPath();
        await mkdir(join(path, 'usage'), { recursive: true });
        await writeFile(
            join(path, 'usage', 'model-prices.json'),
            JSON.stringify({ fetchedAt: 1000, prices: { 'model-a': [1, 2, null, null, null] } }),
        );
        const fetch = vi.fn(() =>
            Promise.resolve(
                Response.json({ 'model-a': { input_cost_per_token: 3, output_cost_per_token: 4 } }),
            ),
        );
        const pricing = new ModelPricing({ userDataPath: path, fetch, now: () => 2000 });
        await pricing.ensureFresh();

        expect(fetch).toHaveBeenCalledOnce();
        expect(pricing.priceOf('model-a')).toEqual([3, 4, null, null, null]);
    });

    it('falls back to the bundled snapshot when the refresh fails', async () => {
        const fetch = vi.fn(() => Promise.resolve(new Response('nope', { status: 500 })));
        const pricing = new ModelPricing({ userDataPath: await userDataPath(), fetch });
        await pricing.ensureFresh();

        expect(pricing.source).toBe('bundled');
        expect(pricing.priceOf('claude-sonnet-4-5')).toBeDefined();
    });
});

describe('cache rewrite estimates', () => {
    it('charges the cache-write rate the lifetime selects, falling back to input', () => {
        expect(cacheWritePrice([1, 2, 0.1, 1.25, 2], 60)).toBe(2);
        expect(cacheWritePrice([1, 2, 0.1, 1.25, 2], 5)).toBe(1.25);
        expect(cacheWritePrice([1, 2, 0.1, 1.25, null], 60)).toBe(1.25);
        expect(cacheWritePrice([1, 2, 0.1, null, null], 30)).toBe(1);
    });

    it('prices a context from the bundled list, ignoring a bracketed variant', () => {
        const hour = estimateCacheRewriteUsd(100_000, 'claude-opus-5-5[1m]', 60);
        expect(hour).toBeCloseTo(0.8);
        expect(estimateCacheRewriteUsd(100_000, 'claude-opus-5-5', 5)).toBeCloseTo(0.5);
        expect(estimateCacheRewriteUsd(100_000, 'fake-model', 60)).toBeUndefined();
        expect(estimateCacheRewriteUsd(0, 'claude-opus-5-5', 60)).toBeUndefined();
    });
});
