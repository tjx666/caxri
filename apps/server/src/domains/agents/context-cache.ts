import type { AgentProvider } from '@caxri/protocol';

interface ContextCacheUsage {
    activityAt: number;
    contextTokens: number;
    ttlMinutes: number;
}
export type ContextCacheObservation =
    | { status: 'measured'; usage: ContextCacheUsage }
    | { status: 'already_compacted' | 'usage_unavailable' };

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as RecordValue)
        : {};
}
function tokens(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
function timestamp(value: unknown): number {
    return typeof value === 'string' ? Date.parse(value) : NaN;
}
function parseLine(line: string): RecordValue {
    try {
        return record(JSON.parse(line));
    } catch {
        return {};
    }
}

/**
 * Reads the last request, never cumulative usage. Estimates match the native cache guard policy: Codex 30 minutes;
 * Claude uses explicit cache-creation lifetime, falling back to one hour when the transcript omits it. These are
 * selection heuristics, not cache-hit guarantees. A compaction boundary invalidates all earlier request usage.
 * https://developers.openai.com/api/docs/guides/prompt-caching
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 */
export function inspectContextCache(
    provider: AgentProvider,
    content: string,
): ContextCacheObservation {
    if (provider === 'grok') return { status: 'usage_unavailable' };
    const lines = content.split('\n');
    let latest: Omit<ContextCacheUsage, 'ttlMinutes'> | undefined;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const entry = parseLine(lines[index]);
        const payload = record(entry.payload);
        const isBoundary =
            provider === 'codex'
                ? entry.type === 'compacted' ||
                  (entry.type === 'event_msg' && payload.type === 'context_compacted')
                : entry.type === 'system' && entry.subtype === 'compact_boundary';
        if (isBoundary) {
            if (!latest) return { status: 'already_compacted' };
            break;
        }
        if (provider === 'codex') {
            if (entry.type !== 'event_msg' || payload.type !== 'token_count') continue;
            const usage = record(record(payload.info).last_token_usage);
            const contextTokens = tokens(usage.input_tokens) || tokens(usage.total_tokens);
            const activityAt = timestamp(entry.timestamp);
            if (contextTokens > 0 && Number.isFinite(activityAt))
                return { status: 'measured', usage: { activityAt, contextTokens, ttlMinutes: 30 } };
        } else {
            if (entry.type !== 'assistant') continue;
            const usage = record(record(entry.message).usage);
            const contextTokens =
                tokens(usage.input_tokens) +
                tokens(usage.cache_creation_input_tokens) +
                tokens(usage.cache_read_input_tokens);
            const activityAt = timestamp(entry.timestamp);
            if (!latest && contextTokens > 0 && Number.isFinite(activityAt))
                latest = { activityAt, contextTokens };
            const creation = record(usage.cache_creation);
            const ttlMinutes =
                tokens(creation.ephemeral_1h_input_tokens) > 0
                    ? 60
                    : tokens(creation.ephemeral_5m_input_tokens) > 0
                      ? 5
                      : undefined;
            if (latest && ttlMinutes)
                return { status: 'measured', usage: { ...latest, ttlMinutes } };
        }
    }
    return latest
        ? { status: 'measured', usage: { ...latest, ttlMinutes: 60 } }
        : { status: 'usage_unavailable' };
}
