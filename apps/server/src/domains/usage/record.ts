import { z } from 'zod';

/**
 * Bumped whenever parsing changes what a stored aggregate means, so every cached row is rescanned once.
 */
export const USAGE_RECORD_VERSION = 2;

const count = z.number().int().nonnegative();

/**
 * Unit of a bucket's `nativeCostTicks`: 10^10 ticks per USD.
 */
export const NATIVE_COST_TICKS_PER_USD = 1e10;

const tokenCounts = [count, count, count, count, count, count, count, count, count] as const;

/**
 * OpenAI processing tiers a Codex request can run at besides the default: `priority` (Codex "fast" mode) and `flex`.
 * Each bills a multiple of the standard list price.
 */
const serviceTierSchema = z.enum(['priority', 'flex']);
export type ServiceTier = z.infer<typeof serviceTierSchema>;

/**
 * One hour of one model's usage at one context size: `[hourStartSeconds, modelIndex, input, output, cacheRead,
 * cacheWrite, cacheWrite1h, reasoning, contextFloorK]`, plus `nativeCostTicks` when the provider priced the requests
 * itself, plus the {@link ServiceTier} when the requests did not run at the standard one (with a `null` cost when the
 * provider did not price them). `cacheWrite` includes `cacheWrite1h`, which is kept separately only because it is
 * priced higher. `contextFloorK` is the largest {@link CONTEXT_FLOORS_K} boundary the requests' context exceeded, so
 * long-context price tiers apply at report time with whatever price list is current. `nativeCostTicks` is the
 * provider's own cost in 10^-10 USD (Grok's `costUsdTicks`); its absence, not a zero, means the bucket is priced from
 * the list.
 */
const tokenBucketSchema = z.union([
    z.tuple(tokenCounts),
    z.tuple([...tokenCounts, count]),
    z.tuple([...tokenCounts, count.nullable(), serviceTierSchema]),
]);

/**
 * `[hourStartSeconds, activeMs]`.
 */
const activityBucketSchema = z.tuple([count, count]);

/**
 * Context-size boundaries, in thousands of tokens, at which price lists switch to a long-context tier (LiteLLM's
 * `*_above_<N>k_tokens` fields). A request is filed under the largest boundary its context strictly exceeds, or 0.
 */
export const CONTEXT_FLOORS_K = [100, 128, 200, 256, 272, 512, 1000] as const;

export function contextFloorK(contextTokens: number): number {
    return CONTEXT_FLOORS_K.findLast((floor) => contextTokens > floor * 1000) ?? 0;
}

/**
 * A short digest of one billed unit's identity (a Claude `message.id:requestId`, a Grok prompt ID). Resume and fork
 * copy these units into a new transcript, so the report counts each digest once across files.
 */
const usageKeySchema = z.string().regex(/^[\w-]{11}$/);

const rateLimitWindowSchema = z.object({
    windowMinutes: count,
    usedPercent: z.number().min(0).max(100),
    resetsAt: count.optional(),
    scope: z.enum(['session', 'weekly']).optional(),
});

/**
 * Content-free aggregate of one Agent Session's transcript files, persisted in `agent_session_usage.usage_json`. It
 * holds token counts, model names, timing, pull request URLs the Agent itself created, and one-way digests of message
 * IDs: never prompts, output, or file contents.
 */
const usageRecordSchema = z.object({
    version: z.literal(USAGE_RECORD_VERSION),
    models: z.array(z.string().min(1).max(200)).max(64),
    tokens: z.array(tokenBucketSchema),
    activity: z.array(activityBucketSchema),
    firstAt: count.optional(),
    lastAt: count.optional(),
    pullRequests: z.array(z.url()).max(64),
    /**
     * Digests of the main transcript's billed units, in file order, including units skipped because an earlier
     * transcript already counts them. Only providers whose resume or fork copies history record them.
     */
    keys: z.array(usageKeySchema).optional(),
    /**
     * Creation time of the main transcript file. Of several files holding the same unit, the earliest-created one
     * counts it: a fork or resume copy is always written after its source.
     */
    bornAt: count.optional(),
    rateLimits: z
        .object({
            observedAt: count,
            planType: z.string().max(64).optional(),
            windows: z.array(rateLimitWindowSchema).max(4),
        })
        .optional(),
});
export type UsageRecord = z.infer<typeof usageRecordSchema>;

export function parseUsageRecord(json: string | null): UsageRecord | undefined {
    if (!json) return;
    try {
        const parsed = usageRecordSchema.safeParse(JSON.parse(json));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}
