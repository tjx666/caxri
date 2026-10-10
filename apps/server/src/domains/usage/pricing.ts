import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import type { UsageTokens } from './accumulator';
import { bundledModelPrices } from './bundled-prices.generated';

/**
 * LiteLLM's community-maintained price list, the same source ccusage uses. Prices are public API list prices, so a cost
 * computed from them is an estimate of what the tokens would cost on the API, not what a subscription plan charged.
 */
export const MODEL_PRICES_URL =
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const REFRESH_INTERVAL_MS = 24 * 3_600_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PRICE_LIST_BYTES = 16 * 1024 * 1024;

/**
 * USD per token: `[input, output, cacheRead, cacheWrite, cacheWrite1h]`. Missing cache prices are `null`.
 */
export type ModelPrice = readonly [number, number, number | null, number | null, number | null];

const pricePerToken = z.number().nonnegative();
const modelPriceSchema = z.tuple([
    pricePerToken,
    pricePerToken,
    pricePerToken.nullable(),
    pricePerToken.nullable(),
    pricePerToken.nullable(),
]);
const cachedPricesSchema = z.object({
    fetchedAt: z.number().int().nonnegative(),
    prices: z.record(z.string(), modelPriceSchema),
});

const liteLlmEntrySchema = z.looseObject({
    input_cost_per_token: pricePerToken,
    output_cost_per_token: pricePerToken,
    cache_read_input_token_cost: pricePerToken.nullish(),
    cache_creation_input_token_cost: pricePerToken.nullish(),
    cache_creation_input_token_cost_above_1hr: pricePerToken.nullish(),
});

/**
 * Keeps only the price fields of chat-capable entries. Regional and batch variants stay out: transcripts name the plain
 * model ID.
 */
export function projectLiteLlmPrices(raw: unknown): Record<string, ModelPrice> {
    const prices: Record<string, ModelPrice> = {};
    if (raw === null || typeof raw !== 'object') return prices;
    for (const [model, value] of Object.entries(raw)) {
        const parsed = liteLlmEntrySchema.safeParse(value);
        if (!parsed.success) continue;
        const entry = parsed.data;
        prices[model] = [
            entry.input_cost_per_token,
            entry.output_cost_per_token,
            entry.cache_read_input_token_cost ?? null,
            entry.cache_creation_input_token_cost ?? null,
            entry.cache_creation_input_token_cost_above_1hr ?? null,
        ];
    }
    return prices;
}

const PROVIDER_PREFIXES = ['', 'anthropic/', 'openai/', 'xai/'];
const DATE_SUFFIX_PATTERN = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * Candidate price-list keys for a transcript model name, most specific first: the exact name, then with a provider
 * prefix, then without a date suffix, then dropping trailing variant segments (`grok-4.7-build` → `grok-4.7`) while at
 * least two segments remain.
 */
export function modelPriceCandidates(model: string): string[] {
    const bases: string[] = [model];
    const undated = model.replace(DATE_SUFFIX_PATTERN, '');
    if (undated !== model) bases.push(undated);
    const segments = undated.split('-');
    for (let length = segments.length - 1; length >= 2; length--)
        bases.push(segments.slice(0, length).join('-'));
    return bases.flatMap((base) => PROVIDER_PREFIXES.map((prefix) => `${prefix}${base}`));
}

export function costOf(tokens: UsageTokens, price: ModelPrice): number {
    const [input, output, cacheRead, cacheWrite, cacheWrite1h] = price;
    const write5m = Math.max(0, tokens.cacheWrite - tokens.cacheWrite1h);
    return (
        tokens.input * input +
        tokens.output * output +
        tokens.cacheRead * (cacheRead ?? input) +
        write5m * (cacheWrite ?? input) +
        tokens.cacheWrite1h * (cacheWrite1h ?? cacheWrite ?? input)
    );
}

/**
 * What cache reads saved compared with paying the uncached input price for the same tokens.
 */
export function cacheSavingsOf(tokens: UsageTokens, price: ModelPrice): number {
    return tokens.cacheRead * Math.max(0, price[0] - (price[2] ?? price[0]));
}

export type PricingSource = 'remote' | 'cache' | 'bundled';

export interface ModelPricingOptions {
    userDataPath: string;
    fetch?: typeof fetch;
    now?: () => number;
}

/**
 * Resolves model prices from, in order: a fresh on-disk copy of the LiteLLM list, a network refresh, a stale on-disk
 * copy, and finally the snapshot bundled with this build. A refresh failure never fails a report.
 */
export class ModelPricing {
    private prices: Record<string, ModelPrice> = bundledModelPrices;
    private resolved = new Map<string, ModelPrice | null>();
    private loading?: Promise<void>;
    private loadedAt?: number;
    source: PricingSource = 'bundled';
    updatedAt?: number;

    constructor(private readonly options: ModelPricingOptions) {}

    private get cachePath(): string {
        return join(this.options.userDataPath, 'usage', 'model-prices.json');
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private use(prices: Record<string, ModelPrice>, source: PricingSource, updatedAt?: number) {
        this.prices = { ...bundledModelPrices, ...prices };
        this.resolved = new Map();
        this.source = source;
        this.updatedAt = updatedAt;
    }

    private async loadOnce(): Promise<void> {
        try {
            await this.load();
        } finally {
            this.loading = undefined;
        }
    }

    private async load(): Promise<void> {
        const cached = await this.readCache();
        if (cached && this.now() - cached.fetchedAt < REFRESH_INTERVAL_MS) {
            this.use(cached.prices, 'cache', cached.fetchedAt);
            this.loadedAt = cached.fetchedAt;
            return;
        }
        const fetched = await this.fetchRemote();
        if (fetched) {
            const fetchedAt = this.now();
            this.use(fetched, 'remote', fetchedAt);
            await this.writeCache({ fetchedAt, prices: fetched });
        } else if (cached) {
            this.use(cached.prices, 'cache', cached.fetchedAt);
        }
        // A failed refresh is retried on the next interval rather than on every report.
        this.loadedAt = this.now();
    }

    private async readCache(): Promise<z.infer<typeof cachedPricesSchema> | undefined> {
        try {
            const parsed = cachedPricesSchema.safeParse(
                JSON.parse(await readFile(this.cachePath, 'utf8')),
            );
            return parsed.success ? parsed.data : undefined;
        } catch {
            return undefined;
        }
    }

    private async writeCache(value: {
        fetchedAt: number;
        prices: Record<string, ModelPrice>;
    }): Promise<void> {
        try {
            await mkdir(dirname(this.cachePath), { recursive: true });
            const temporary = `${this.cachePath}.${process.pid}.tmp`;
            await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
            await rename(temporary, this.cachePath);
        } catch {
            // The in-memory copy still serves this process; the next start refetches.
        }
    }

    private async fetchRemote(): Promise<Record<string, ModelPrice> | undefined> {
        try {
            const response = await (this.options.fetch ?? fetch)(MODEL_PRICES_URL, {
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!response.ok) return;
            const text = await response.text();
            if (text.length > MAX_PRICE_LIST_BYTES) return;
            const prices = projectLiteLlmPrices(JSON.parse(text));
            return Object.keys(prices).length > 0 ? prices : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Settles once prices are as fresh as possible; concurrent reports share one refresh.
     */
    async ensureFresh(): Promise<void> {
        if (this.loadedAt !== undefined && this.now() - this.loadedAt < REFRESH_INTERVAL_MS) return;
        this.loading ??= this.loadOnce();
        await this.loading;
    }

    priceOf(model: string): ModelPrice | undefined {
        const cached = this.resolved.get(model);
        if (cached !== undefined) return cached ?? undefined;
        let price: ModelPrice | undefined;
        for (const candidate of modelPriceCandidates(model)) {
            price = Object.hasOwn(this.prices, candidate) ? this.prices[candidate] : undefined;
            if (price) break;
        }
        this.resolved.set(model, price ?? null);
        return price;
    }
}
