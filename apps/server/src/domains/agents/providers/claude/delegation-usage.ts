import type { AgentDelegationUsage } from '@caxri/protocol';
import { agentDelegationUsageSchema } from '@caxri/protocol';

const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

/**
 * Streaming blocks share an API message ID; their usage snapshots must not be billed repeatedly.
 */
export function collectClaudeUsage(
    messages: Map<string, AgentDelegationUsage | undefined | null>,
    message: Record<string, unknown> | undefined,
    fallbackId: string,
): void {
    const id = typeof message?.id === 'string' ? message.id : fallbackId;
    const raw = message?.usage;
    const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const parsed = agentDelegationUsageSchema.safeParse({
        source: 'provider',
        scope: 'main-thread',
        inputTokens: source.input_tokens,
        outputTokens: source.output_tokens,
        cacheReadTokens: source.cache_read_input_tokens,
        cacheWriteTokens: source.cache_creation_input_tokens,
    });
    const previous = messages.get(id);
    if (previous === null) return;
    if (!parsed.success || typeof message?.id !== 'string') {
        if (raw !== undefined && !parsed.success) messages.set(id, null);
        else if (!messages.has(id)) messages.set(id, undefined);
        return;
    }
    const usage = parsed.data;
    for (const field of fields) {
        const prior = previous?.[field];
        if (prior !== undefined) usage[field] = Math.max(prior, usage[field] ?? prior);
    }
    messages.set(id, usage);
}

export function totalClaudeUsage(
    messages: ReadonlyMap<string, AgentDelegationUsage | undefined | null>,
): AgentDelegationUsage | undefined {
    const values = messages.values().toArray();
    if (values.length === 0 || values.includes(undefined) || values.includes(null)) return;
    const totals: Record<string, unknown> = { source: 'provider', scope: 'main-thread' };
    for (const field of fields) {
        const counters = values.map((value) => value?.[field]);
        if (counters.every((value) => value !== undefined))
            totals[field] = counters.reduce((sum, value) => sum + value, 0);
    }
    const parsed = agentDelegationUsageSchema.safeParse(totals);
    return parsed.success ? parsed.data : undefined;
}
