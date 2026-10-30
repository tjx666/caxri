import { z } from 'zod';

import { agentProviderSchema } from './agents.js';

/**
 * Most recent measured responses kept for the status bar's per-response chart.
 */
export const AGENT_THROUGHPUT_SAMPLE_LIMIT = 20;
/**
 * Responses folded into the headline rate. A token-weighted window this short follows a slowdown within a minute or two
 * while a single tiny response (a short tool call that is mostly waiting for the first token) cannot swing it alone.
 */
export const AGENT_THROUGHPUT_RECENT_RESPONSES = 10;

/**
 * The provider's speed tier for a response: Claude Code's `usage.speed` (`fast` with `/fast` on), or the Codex thread's
 * `service_tier` (`priority` or `fast` is Codex's Fast mode, `flex` OpenAI's slower flex processing).
 */
export const agentThroughputSpeeds = ['standard', 'fast', 'flex'] as const;
export const agentThroughputSpeedSchema = z.enum(agentThroughputSpeeds);

const responseVariantFields = {
    /**
     * Model id as the transcript records it, such as `gpt-5.6-sol` or `claude-opus-5-5`.
     */
    model: z.string().max(200).optional(),
    /**
     * Absent when the transcript does not record the tier: Codex writes it only once the thread's settings change, so
     * responses before the first change carry no tier.
     */
    speed: agentThroughputSpeedSchema.optional(),
};

/**
 * One measured model response. `durationMs` runs from the moment the request's last input was recorded (the prompt or
 * the final tool result) to the provider's last generated item, so it includes queueing and time to first token but
 * never tool execution.
 */
const agentThroughputSampleSchema = z.object({
    outputTokens: z.number().int().positive(),
    durationMs: z.number().positive(),
    /**
     * Epoch milliseconds of the response's last generated item.
     */
    completedAt: z.number(),
    ...responseVariantFields,
});

/**
 * Token-weighted total over several responses: `outputTokens / durationMs`, never an average of per-response rates.
 */
const agentThroughputAggregateSchema = z.object({
    outputTokens: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    responseCount: z.number().int().nonnegative(),
});

/**
 * Output throughput of an Agent Terminal's bound conversation, derived from timestamps and token usage the provider
 * already writes to its own transcript. Contains numbers only, never conversation content.
 */
/**
 * Every measured response of one model at one speed tier, so models and Fast mode can be compared side by side.
 */
const agentThroughputVariantSchema = agentThroughputAggregateSchema.extend(responseVariantFields);

export const agentThroughputSchema = z.object({
    provider: agentProviderSchema,
    /**
     * The last {@link AGENT_THROUGHPUT_RECENT_RESPONSES} measured responses.
     */
    recent: agentThroughputAggregateSchema,
    /**
     * Responses since the latest turn started.
     */
    turn: agentThroughputAggregateSchema,
    /**
     * Provider-reported time to first token for the latest finished turn, when the provider records one (Codex).
     */
    turnTimeToFirstTokenMs: z.number().nonnegative().optional(),
    /**
     * Every measured response in the transcript.
     */
    session: agentThroughputAggregateSchema,
    /**
     * `session` split by model and speed tier, most responses first.
     */
    byModel: z.array(agentThroughputVariantSchema).max(32),
    /**
     * Oldest first, at most {@link AGENT_THROUGHPUT_SAMPLE_LIMIT}.
     */
    samples: z.array(agentThroughputSampleSchema).max(AGENT_THROUGHPUT_SAMPLE_LIMIT),
});

export type AgentThroughputSample = z.infer<typeof agentThroughputSampleSchema>;
export type AgentThroughputAggregate = z.infer<typeof agentThroughputAggregateSchema>;
export type AgentThroughput = z.infer<typeof agentThroughputSchema>;
export type AgentThroughputSpeed = z.infer<typeof agentThroughputSpeedSchema>;
export type AgentThroughputVariant = z.infer<typeof agentThroughputVariantSchema>;
