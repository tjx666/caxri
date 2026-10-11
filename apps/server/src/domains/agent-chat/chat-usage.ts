import type { AgentChatUsage } from '@caxri/protocol';

import { estimateCacheRewriteUsd } from '../usage';

/**
 * Adds what rewriting this context into an expired prompt cache would cost, so the composer can say what an idle Chat's
 * next message spends. The model is the one that answered, as the provider names it.
 */
export function withCacheRewriteEstimate(
    usage: AgentChatUsage,
    model: string | undefined,
): AgentChatUsage {
    const cost =
        model && usage.cacheTtlMinutes
            ? estimateCacheRewriteUsd(usage.totalTokens, model, usage.cacheTtlMinutes)
            : undefined;
    return cost === undefined ? usage : { ...usage, cacheRewriteUsd: cost };
}
