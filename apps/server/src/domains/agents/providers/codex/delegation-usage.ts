import type { AgentDelegationUsage } from '@caxri/protocol';
import { agentDelegationUsageSchema } from '@caxri/protocol';

import type { DelegationEvidence } from '../../delegation-contract';

const fields = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'totalTokens',
] as const;

function counters(value: unknown): AgentDelegationUsage | undefined {
    if (!value || typeof value !== 'object') return;
    const raw = value as Record<string, unknown>;
    const parsed = agentDelegationUsageSchema.safeParse({
        source: 'provider',
        scope: 'main-thread',
        inputTokens: raw.input_tokens,
        outputTokens: raw.output_tokens,
        cacheReadTokens: raw.cached_input_tokens,
        cacheWriteTokens: raw.cache_write_input_tokens,
        reasoningTokens: raw.reasoning_output_tokens,
        totalTokens: raw.total_tokens,
    });
    return parsed.success ? parsed.data : undefined;
}

/**
 * Token_count has no turn ID. Only an exact task_started/task_complete interval and a proven cumulative baseline
 * authorize a delta; a bounded tail, reset, interleaved turn or missing counter remains unknown.
 *
 * @see https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
 */
export function extractCodexDelegationUsage(
    content: string,
    evidence: DelegationEvidence,
): AgentDelegationUsage | undefined {
    let isFresh = false;
    let hasEarlierTurn = false;
    let isOwned = false;
    let hasCounter = false;
    let latest: AgentDelegationUsage | undefined;
    let baseline: AgentDelegationUsage | undefined;
    records: for (const line of content.split('\n')) {
        let parsedRow: unknown;
        try {
            parsedRow = JSON.parse(line);
        } catch {
            if (line.trim()) {
                if (isOwned) return;
                latest = undefined;
                hasEarlierTurn = true;
            }
            continue;
        }
        if (!parsedRow || typeof parsedRow !== 'object' || Array.isArray(parsedRow)) continue;
        const row = parsedRow as { type?: string; payload?: Record<string, unknown> };
        const payload = row.payload;
        if (!payload || typeof payload !== 'object') continue;
        if (row.type === 'session_meta' && payload.id === evidence.sessionId) isFresh = true;
        if (row.type !== 'event_msg') continue;
        switch (payload.type) {
            case 'task_started':
            case 'turn_started': {
                if (isOwned) return;
                if (payload.turn_id !== evidence.turnId) {
                    hasEarlierTurn = true;
                    continue records;
                }
                isOwned = true;
                baseline =
                    latest ??
                    (isFresh && !hasEarlierTurn
                        ? {
                              source: 'provider',
                              scope: 'main-thread',
                              inputTokens: 0,
                              outputTokens: 0,
                              cacheReadTokens: 0,
                              cacheWriteTokens: 0,
                              reasoningTokens: 0,
                              totalTokens: 0,
                          }
                        : undefined);
                if (!baseline) return;

                continue records;
            }
            case 'token_count': {
                const info = payload.info as Record<string, unknown> | undefined;
                const next = counters(info?.total_token_usage);
                if (!next) {
                    if (isOwned && info != null) return;
                    continue records;
                }
                if (isOwned) {
                    const previous = latest ?? baseline;
                    if (
                        fields.some(
                            (field) =>
                                next[field] !== undefined &&
                                previous?.[field] !== undefined &&
                                next[field] < previous[field],
                        )
                    )
                        return;
                    hasCounter = true;
                }
                latest = next;

                continue records;
            }
            case 'task_complete':
            case 'turn_complete': {
                if (!isOwned) {
                    hasEarlierTurn = true;
                    continue records;
                }
                if (!hasCounter || !latest || !baseline || payload.turn_id !== evidence.turnId)
                    return;
                const result: Record<string, unknown> = {
                    source: 'provider',
                    scope: 'main-thread',
                };
                for (const field of fields) {
                    const before = baseline[field];
                    const after = latest[field];
                    if (before !== undefined && after !== undefined) result[field] = after - before;
                }
                const parsed = agentDelegationUsageSchema.safeParse(result);
                return parsed.success ? parsed.data : undefined;
            }
            default:
                if (
                    isOwned &&
                    (payload.type === 'context_compacted' || payload.type === 'turn_aborted')
                )
                    return;
        }
    }
    return;
}
