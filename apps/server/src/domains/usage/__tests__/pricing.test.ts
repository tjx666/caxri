import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    cacheWritePrice,
    estimateCacheRewriteUsd,
    modelPriceCandidates,
    ModelPricing,
    projectLiteLlmPrices,
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
});

describe('ModelPricing', () => {
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
