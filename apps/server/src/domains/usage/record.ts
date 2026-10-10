import { z } from 'zod';

/**
 * Bumped whenever parsing changes what a stored aggregate means, so every cached row is rescanned once.
 */
export const USAGE_RECORD_VERSION = 1;

const count = z.number().int().nonnegative();

/**
 * One hour of one model's usage: `[hourStartSeconds, modelIndex, input, output, cacheRead, cacheWrite, cacheWrite1h,
 * reasoning]`. `cacheWrite` includes `cacheWrite1h`, which is kept separately only because it is priced higher.
 */
const tokenBucketSchema = z.tuple([count, count, count, count, count, count, count, count]);

/**
 * `[hourStartSeconds, activeMs]`.
 */
const activityBucketSchema = z.tuple([count, count]);

const rateLimitWindowSchema = z.object({
    windowMinutes: count,
    usedPercent: z.number().min(0).max(100),
    resetsAt: count.optional(),
});

/**
 * Content-free aggregate of one Agent Session's transcript files, persisted in `agent_session_usage.usage_json`. It
 * holds token counts, model names, timing, and pull request URLs the Agent itself created: never prompts, output, or
 * file contents.
 */
const usageRecordSchema = z.object({
    version: z.literal(USAGE_RECORD_VERSION),
    models: z.array(z.string().min(1).max(200)).max(64),
    tokens: z.array(tokenBucketSchema),
    activity: z.array(activityBucketSchema),
    firstAt: count.optional(),
    lastAt: count.optional(),
    pullRequests: z.array(z.url()).max(64),
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
