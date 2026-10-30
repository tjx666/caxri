import { z } from 'zod';

import { agentProviderIds, agentProviderSchema } from '../agent/agents.js';
import { agentProviderStatusSchema } from '../desktop/agent-provider-status-contract.js';
import { identifierSchema } from '../domain/identifiers.js';
import { usageLimitSchema } from '../domain/usage-contract.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * The Agents the phone's Agent usage screen always lists, in order, even before any reading: the two whose plans have
 * rate-limit windows and public status pages. Another provider joins only once it reports a plan limit.
 */
export const MOBILE_AGENT_USAGE_PROVIDERS = ['claude', 'codex'] as const;

/**
 * Unresolved incidents the phone receives per provider, and the characters of each one's newest update. A status page
 * may list sixteen incidents of four thousand characters; the screen shows a few, each clipped to a short paragraph.
 */
export const MOBILE_AGENT_USAGE_INCIDENTS = 4;
export const MOBILE_AGENT_USAGE_INCIDENT_UPDATE_CHARS = 600;

/**
 * Output speed of the provider's most recently active Agent the device may see, as the Desktop status bar's tok/s chip
 * measures it: the token-weighted rate over its last few measured responses (`outputTokens / durationMs`).
 */
const mobileAgentThroughputSchema = z.strictObject({
    outputTokens: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    responseCount: z.number().int().nonnegative(),
    /**
     * Epoch milliseconds of the newest measured response.
     */
    lastResponseAt: z.number(),
    model: z.string().max(200).optional(),
    /**
     * The Session the speed was measured in, so the reading names its source.
     */
    sessionId: identifierSchema,
    sessionTitle: z.string().max(200),
});

const mobileAgentUsageProviderSchema = z.strictObject({
    provider: agentProviderSchema,
    /**
     * The newest account-wide plan reading; absent before the provider has reported one (an API key has none, and
     * Claude Code reports one only while one of its Chats runs).
     */
    limit: usageLimitSchema.optional(),
    throughput: mobileAgentThroughputSchema.optional(),
    /**
     * The provider's public status page without uptime history, incidents clipped to
     * {@link MOBILE_AGENT_USAGE_INCIDENTS}. Absent for a provider without a public status page.
     */
    serviceStatus: agentProviderStatusSchema.optional(),
});

/**
 * The phone's Agent usage screen: plan limits, output speed, and service status per Agent. Open to every role: plan
 * limits and public status pages are account facts, not Project data, and the throughput source is chosen only among
 * Sessions the device may see.
 */
export const mobileAgentUsageMethods = {
    'mobile.agentUsage.read': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({}),
        result: z.strictObject({
            providers: z.array(mobileAgentUsageProviderSchema).max(agentProviderIds.length),
        }),
    },
} as const satisfies Record<string, MethodSpec>;

export type MobileAgentThroughput = z.infer<typeof mobileAgentThroughputSchema>;
export type MobileAgentUsageProvider = z.infer<typeof mobileAgentUsageProviderSchema>;
