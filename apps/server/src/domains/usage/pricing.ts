import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import type { UsageTokens } from './accumulator';
import bundledPricesJson from './bundled-prices.generated.json';
import type { ServiceTier } from './record';
import { CONTEXT_FLOORS_K } from './record';

/**
 * LiteLLM's community-maintained price list, the same source ccusage uses. Prices are public API list prices, so a cost
 * computed from them is an estimate of what the tokens would cost on the API, not what a subscription plan charged.
 */
export const MODEL_PRICES_URL =
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const REFRESH_INTERVAL_MS = 24 * 3_600_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PRICE_LIST_BYTES = 16 * 1024 * 1024;

type Rates = readonly [number, number, number | null, number | null, number | null];

/**
 * A long-context tier: `[thresholdK, input, output, cacheRead, cacheWrite, cacheWrite1h]` in USD per token. Once a
 * request's whole input context exceeds `thresholdK` thousand tokens, every token of that request is billed at the
 * tier's rates, the vendors' rule (Anthropic, OpenAI, and xAI switch the whole request, not the tokens past the
 * boundary). Rates the price list leaves out are the base rates.
 */
type PriceTier = readonly [number, ...Rates];

/**
 * What a model's price list adds to its standard rates: long-context tiers ordered by threshold, and how many times the
 * standard price a request at another processing tier costs (LiteLLM's `*_priority` and `*_flex` rates; OpenAI's
 * priority processing, which Codex calls fast mode, is 2x for most models).
 */
interface PriceExtras {
    tiers?: readonly PriceTier[];
    serviceTiers?: Partial<Record<ServiceTier, number>>;
}

/**
 * USD per token: `[input, output, cacheRead, cacheWrite, cacheWrite1h]`, plus {@link PriceExtras} when the model has
 * any. Missing cache prices are `null`.
 */
export type ModelPrice = Rates | readonly [...Rates, PriceExtras];

const pricePerToken = z.number().nonnegative();
const ratesShape = [
    pricePerToken,
    pricePerToken,
    pricePerToken.nullable(),
    pricePerToken.nullable(),
    pricePerToken.nullable(),
] as const;
const priceTierSchema = z.tuple([z.number().int().positive(), ...ratesShape]);
const priceMultiplier = z.number().positive().max(100).optional();
const serviceTierMultipliersSchema = z.object({ priority: priceMultiplier, flex: priceMultiplier });
const priceTiersSchema = z.array(priceTierSchema).max(CONTEXT_FLOORS_K.length);
const priceExtrasSchema = z.object({
    tiers: priceTiersSchema.optional(),
    serviceTiers: serviceTierMultipliersSchema.optional(),
});
const modelPriceSchema = z.union([
    z.tuple(ratesShape),
    z.tuple([...ratesShape, priceExtrasSchema]),
]);
/**
 * Bumped whenever the cached projection gains a field, so a stale cache refetches instead of pricing without it.
 */
const PRICE_CACHE_VERSION = 3;
const cachedPricesSchema = z.object({
    version: z.literal(PRICE_CACHE_VERSION),
    fetchedAt: z.number().int().nonnegative(),
    prices: z.record(z.string(), modelPriceSchema),
});

/**
 * The snapshot `scripts/update-model-prices.ts` generated at build time; validated like a cached list.
 */
const bundledModelPrices: Record<string, ModelPrice> = z
    .record(z.string(), modelPriceSchema)
    .parse(bundledPricesJson);

const liteLlmEntrySchema = z.looseObject({
    input_cost_per_token: pricePerToken,
    output_cost_per_token: pricePerToken,
    cache_read_input_token_cost: pricePerToken.nullish(),
    cache_creation_input_token_cost: pricePerToken.nullish(),
    cache_creation_input_token_cost_above_1hr: pricePerToken.nullish(),
});

const TIER_FIELD_PATTERN =
    /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost|cache_creation_input_token_cost_above_1hr)_above_(\d+)k_tokens$/;
const TIER_FIELD_INDEX: Record<string, number> = {
    input_cost_per_token: 0,
    output_cost_per_token: 1,
    cache_read_input_token_cost: 2,
    cache_creation_input_token_cost: 3,
    cache_creation_input_token_cost_above_1hr: 4,
};

/**
 * Long-context tiers from LiteLLM's `*_above_<N>k_tokens` fields. Batch, flex, and priority variants end in another
 * suffix and stay out. A threshold the usage record cannot resolve (not in {@link CONTEXT_FLOORS_K}) is dropped rather
 * than applied at the wrong size.
 */
function liteLlmTiers(entry: Record<string, unknown>, base: Rates): PriceTier[] {
    const tiers = new Map<number, Array<number | null | undefined>>();
    for (const [field, value] of Object.entries(entry)) {
        const match = TIER_FIELD_PATTERN.exec(field);
        if (!match || typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
        const thresholdK = Number(match[2]);
        if (!(CONTEXT_FLOORS_K as readonly number[]).includes(thresholdK)) continue;
        const rates = tiers.get(thresholdK) ?? [];
        rates[TIER_FIELD_INDEX[match[1]]] = value;
        tiers.set(thresholdK, rates);
    }
    return tiers
        .entries()
        .filter(([, rates]) => rates[0] !== undefined || rates[1] !== undefined)
        .map(([thresholdK, rates]): PriceTier => [
            thresholdK,
            rates[0] ?? base[0],
            rates[1] ?? base[1],
            rates[2] ?? base[2],
            rates[3] ?? base[3],
            rates[4] ?? base[4],
        ])
        .toArray()
        .toSorted((a, b) => a[0] - b[0]);
}

/**
 * Processing-tier multipliers from LiteLLM's `input_cost_per_token_priority` and `_flex` rates, relative to the
 * standard input rate. The vendors scale every rate of a request by the same factor, so the input rate stands for all.
 */
function liteLlmServiceTiers(
    entry: z.infer<typeof liteLlmEntrySchema>,
): PriceExtras['serviceTiers'] {
    if (entry.input_cost_per_token <= 0) return undefined;
    const multipliers: NonNullable<PriceExtras['serviceTiers']> = {};
    for (const tier of ['priority', 'flex'] as const) {
        const rate = entry[`input_cost_per_token_${tier}`];
        if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0)
            multipliers[tier] = Number((rate / entry.input_cost_per_token).toPrecision(6));
    }
    return Object.keys(multipliers).length > 0 ? multipliers : undefined;
}

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
        const base: Rates = [
            entry.input_cost_per_token,
            entry.output_cost_per_token,
            entry.cache_read_input_token_cost ?? null,
            entry.cache_creation_input_token_cost ?? null,
            entry.cache_creation_input_token_cost_above_1hr ?? null,
        ];
        const tiers = liteLlmTiers(entry, base);
        const serviceTiers = liteLlmServiceTiers(entry);
        const hasTiers = tiers.length > 0;
        prices[model] =
            serviceTiers || hasTiers
                ? [...base, { ...(hasTiers && { tiers }), ...(serviceTiers && { serviceTiers }) }]
                : base;
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

/**
 * The price list entry for a model name, trying {@link modelPriceCandidates} in order.
 */
function findModelPrice(
    prices: Readonly<Record<string, ModelPrice>>,
    model: string,
): ModelPrice | undefined {
    for (const candidate of modelPriceCandidates(model))
        if (Object.hasOwn(prices, candidate)) return prices[candidate];
    return undefined;
}

/**
 * USD per token to write a prompt-cache entry that lives `ttlMinutes`: the one-hour rate from an hour on, otherwise the
 * five-minute rate. A model without a cache-write price (an older OpenAI model) reprocesses the prefix at the input
 * rate.
 */
export function cacheWritePrice(price: ModelPrice, ttlMinutes: number): number {
    const writeRate = price[3] ?? price[0];
    return ttlMinutes >= 60 ? (price[4] ?? writeRate) : writeRate;
}

/**
 * The standard API price of writing `tokens` of context back into an expired prompt cache, from the price list bundled
 * with this build. Subscription plans spend allowance rather than billing this, so it is an estimate of weight, not an
 * invoice. A bracketed Claude Code variant such as `[1m]` is not part of the model name.
 */
export function estimateCacheRewriteUsd(
    tokens: number,
    model: string,
    ttlMinutes: number,
): number | undefined {
    const price = findModelPrice(bundledModelPrices, model.replace(/\[[^\]]*\]$/u, ''));
    return price && tokens > 0 ? tokens * cacheWritePrice(price, ttlMinutes) : undefined;
}

/**
 * The rates for a request filed under `contextFloorK` (see `contextFloorK` in `record.ts`): the highest tier whose
 * threshold the context exceeded, else the base rates.
 */
export function ratesFor(price: ModelPrice, contextFloorK = 0): Rates {
    const tiers = (price.length === 6 ? price[5].tiers : undefined) ?? [];
    const tier = tiers.findLast(([thresholdK]) => thresholdK <= contextFloorK);
    return tier
        ? [tier[1], tier[2], tier[3], tier[4], tier[5]]
        : [price[0], price[1], price[2], price[3], price[4]];
}

/**
 * How many times the standard price a request at `serviceTier` costs; 1 when the price list does not say.
 */
function serviceTierMultiplier(price: ModelPrice, serviceTier: ServiceTier | undefined): number {
    if (!serviceTier || price.length !== 6) return 1;
    return price[5].serviceTiers?.[serviceTier] ?? 1;
}

export interface UsagePriceClass {
    /**
     * See `contextFloorK` in `record.ts`.
     */
    contextFloorK?: number;
    serviceTier?: ServiceTier;
}

export function costOf(
    tokens: UsageTokens,
    price: ModelPrice,
    { contextFloorK = 0, serviceTier }: UsagePriceClass = {},
): number {
    const [input, output, cacheRead, cacheWrite, cacheWrite1h] = ratesFor(price, contextFloorK);
    const write5m = Math.max(0, tokens.cacheWrite - tokens.cacheWrite1h);
    return (
        (tokens.input * input +
            tokens.output * output +
            tokens.cacheRead * (cacheRead ?? input) +
            write5m * (cacheWrite ?? input) +
            tokens.cacheWrite1h * (cacheWrite1h ?? cacheWrite ?? input)) *
        serviceTierMultiplier(price, serviceTier)
    );
}

/**
 * What cache reads saved compared with paying the uncached input price for the same tokens.
 */
export function cacheSavingsOf(
    tokens: UsageTokens,
    price: ModelPrice,
    { contextFloorK = 0, serviceTier }: UsagePriceClass = {},
): number {
    const [input, , cacheRead] = ratesFor(price, contextFloorK);
    return (
        tokens.cacheRead *
        Math.max(0, input - (cacheRead ?? input)) *
        serviceTierMultiplier(price, serviceTier)
    );
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
            await writeFile(temporary, JSON.stringify({ version: PRICE_CACHE_VERSION, ...value }), {
                mode: 0o600,
            });
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
        const price = findModelPrice(this.prices, model);
        this.resolved.set(model, price ?? null);
        return price;
    }
}
