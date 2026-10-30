import type { AgentProvider } from '@caxri/protocol';

interface ContextCacheUsage {
    activityAt: number;
    contextTokens: number;
    /**
     * Minutes the cache survives idle; `undefined` means it never expires (a ChatGPT-signed-in Codex).
     */
    ttlMinutes?: number;
}
export interface ContextCacheOptions {
    /**
     * The Codex sign-in keeps its prompt cache with no expiry; see `hasForeverCodexCache`.
     */
    codexCacheForever?: boolean;
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
 * Codex records each request's own usage on `token_count` events, so the newest measurable one is the answer and any
 * compaction marker seen first means nothing current survived it.
 */
function inspectCodexRequests(
    lines: readonly string[],
    options: ContextCacheOptions,
): ContextCacheObservation {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const entry = parseLine(lines[index]);
        const payload = record(entry.payload);
        if (
            entry.type === 'compacted' ||
            (entry.type === 'event_msg' && payload.type === 'context_compacted')
        )
            return { status: 'already_compacted' };
        if (entry.type !== 'event_msg' || payload.type !== 'token_count') continue;
        const usage = record(record(payload.info).last_token_usage);
        const contextTokens = tokens(usage.input_tokens) || tokens(usage.total_tokens);
        const activityAt = timestamp(entry.timestamp);
        if (contextTokens > 0 && Number.isFinite(activityAt))
            return {
                status: 'measured',
                usage: {
                    activityAt,
                    contextTokens,
                    ...(!options.codexCacheForever && { ttlMinutes: 30 }),
                },
            };
    }
    return { status: 'usage_unavailable' };
}

/**
 * Claude splits the newest request's size from its cache lifetime: a cache-read-only response carries no creation TTL,
 * so earlier creation evidence up to the last compaction boundary supplies it.
 */
function inspectClaudeRequests(lines: readonly string[]): ContextCacheObservation {
    let latest: Omit<ContextCacheUsage, 'ttlMinutes'> | undefined;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const entry = parseLine(lines[index]);
        if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
            if (!latest) return { status: 'already_compacted' };
            break;
        }
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
        if (latest && ttlMinutes) return { status: 'measured', usage: { ...latest, ttlMinutes } };
    }
    return latest
        ? { status: 'measured', usage: { ...latest, ttlMinutes: 60 } }
        : { status: 'usage_unavailable' };
}

/**
 * Exhaustive on purpose: a newly catalogued provider fails to compile until it declares how its transcript records
 * per-request usage, instead of being read with another provider's record shapes. `null` declares that the transcript
 * has no usable evidence, so batch compaction reports `usage_unavailable` and skips it.
 */
const contextCacheInspectors: Record<
    AgentProvider,
    ((lines: readonly string[], options: ContextCacheOptions) => ContextCacheObservation) | null
> = {
    claude: inspectClaudeRequests,
    codex: inspectCodexRequests,
    /**
     * Batch compaction does not touch Grok Sessions; see `docs/session-compaction.md`.
     */
    grok: null,
    /**
     * Batch compaction does not touch Antigravity Sessions; their records are SQLite databases, not transcripts.
     */
    antigravity: null,
};

/**
 * Reads the last request, never cumulative usage. Estimates match the native cache guard policy: Codex 30 minutes, or
 * no expiry when `codexCacheForever` says the ChatGPT sign-in keeps its cache; Claude uses explicit cache-creation
 * lifetime, falling back to one hour when the transcript omits it. These are selection heuristics, not cache-hit
 * guarantees. A compaction boundary invalidates all earlier request usage.
 * https://developers.openai.com/api/docs/guides/prompt-caching
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 */
export function inspectContextCache(
    provider: AgentProvider,
    content: string,
    options: ContextCacheOptions = {},
): ContextCacheObservation {
    const inspect = contextCacheInspectors[provider];
    return inspect ? inspect(content.split('\n'), options) : { status: 'usage_unavailable' };
}
