import type { AgentChatContextChange, AgentChatContextRequest } from '@caxri/protocol';

/**
 * A request counts as a cache miss when it read more than this share of the previous prompt less than that prompt held.
 * Paired with {@link MISS_MIN_TOKENS}, this is the rule Claude Code's own status line applies, so the two never disagree
 * about whether a request missed.
 *
 * @see https://code.claude.com/docs/en/statusline
 */
const MISS_MIN_SHARE = 0.05;
const MISS_MIN_TOKENS = 2_000;

/**
 * How long after the request that missed a change to the prompt's prefix may still be its cause: the Server notices
 * changes from the context read that follows each response, which lands shortly after the response itself.
 */
const CHANGE_ATTRIBUTION_SLACK_MS = 30_000;

/**
 * Why a request rewrote the cache, earliest cause first: `compaction` replaced the conversation by design; `model`
 * switched to a model with a cache of its own; `ttl` came after the cache had expired; `prefix` means something before
 * the new messages changed (tools, system prompt, memory, an edited history) while the cache was still warm.
 */
type CacheBreakKind = 'compaction' | 'model' | 'ttl' | 'prefix';

export interface CacheBreak {
    /**
     * Position in the report's requests.
     */
    index: number;
    at: number;
    kind: CacheBreakKind;
    /**
     * Tokens the previous request's prompt held, which this one could have read from the cache.
     */
    expected: number;
    /**
     * Tokens this request did read from the cache: the prefix that survived.
     */
    kept: number;
    /**
     * Tokens this request wrote to the cache, the price of the break.
     */
    rewritten: number;
    rewriteUsd?: number;
    /**
     * Time since the previous request.
     */
    idleMs: number;
    ttlMinutes: number;
    fromModel?: string;
    toModel?: string;
    /**
     * Prefix changes the live Chat noticed around this request: the likeliest cause of a `prefix` break.
     */
    changes: AgentChatContextChange[];
}

export interface CacheRequestPoint {
    at: number;
    read: number;
    write: number;
    input: number;
    output: number;
    model?: string;
    breakKind?: CacheBreakKind;
}

export interface CacheAnalysis {
    points: CacheRequestPoint[];
    breaks: CacheBreak[];
    /**
     * Share of all prompt tokens served from the cache.
     */
    hitRate: number;
    readTokens: number;
    writeTokens: number;
    inputTokens: number;
    writeUsd: number;
    /**
     * Breaks that were not compaction: the cache was lost to time, a model switch, or a changed prefix.
     */
    misses: number;
    /**
     * Tokens rewritten by those misses, and their estimated price.
     */
    missTokens: number;
    missUsd: number;
    /**
     * Whether any cache write in the replay has no price, so the dollar totals undercount.
     */
    hasUnpricedWrites: boolean;
    /**
     * Lifetime the latest cache write used.
     */
    ttlMinutes: number;
}

function promptTokens(request: AgentChatContextRequest): number {
    return request.input + request.cacheRead + request.cacheWrite;
}

/**
 * Replays the requests to find where the prompt cache broke and why. Each request's prompt starts with the previous
 * one's, so a request that reads markedly less than the previous prompt held lost the rest: the cache broke right after
 * the `cacheRead` tokens it kept.
 */
export function analyzeContextCache(
    requests: readonly AgentChatContextRequest[],
    changes: readonly AgentChatContextChange[],
    fallbackTtlMinutes: number,
): CacheAnalysis {
    const points: CacheRequestPoint[] = [];
    const breaks: CacheBreak[] = [];
    let ttlMinutes = fallbackTtlMinutes;
    let totals = { read: 0, write: 0, input: 0, writeUsd: 0, isUnpriced: false };
    for (const [index, request] of requests.entries()) {
        const previous = index > 0 ? requests[index - 1] : null;
        const found = previous && findBreak(request, previous, index, ttlMinutes, changes);
        if (found) breaks.push(found);
        if (request.cacheTtlMinutes) ttlMinutes = request.cacheTtlMinutes;
        totals = {
            read: totals.read + request.cacheRead,
            write: totals.write + request.cacheWrite,
            input: totals.input + request.input,
            writeUsd: totals.writeUsd + (request.cacheWriteUsd ?? 0),
            isUnpriced:
                totals.isUnpriced ||
                (request.cacheWrite > 0 && request.cacheWriteUsd === undefined),
        };
        points.push({
            at: request.at,
            read: request.cacheRead,
            write: request.cacheWrite,
            input: request.input,
            output: request.output,
            ...(request.model && { model: request.model }),
            ...(found && { breakKind: found.kind }),
        });
    }
    const misses = breaks.filter((item) => item.kind !== 'compaction');
    const prompt = totals.read + totals.write + totals.input;
    return {
        points,
        breaks,
        hitRate: prompt > 0 ? totals.read / prompt : 0,
        readTokens: totals.read,
        writeTokens: totals.write,
        inputTokens: totals.input,
        writeUsd: totals.writeUsd,
        misses: misses.length,
        missTokens: misses.reduce((sum, item) => sum + item.rewritten, 0),
        missUsd: misses.reduce((sum, item) => sum + (item.rewriteUsd ?? 0), 0),
        hasUnpricedWrites: totals.isUnpriced,
        ttlMinutes,
    };
}

function findBreak(
    request: AgentChatContextRequest,
    previous: AgentChatContextRequest,
    index: number,
    ttlMinutes: number,
    changes: readonly AgentChatContextChange[],
): CacheBreak | undefined {
    const expected = promptTokens(previous);
    const lost = expected - request.cacheRead;
    if (lost < MISS_MIN_TOKENS || lost <= expected * MISS_MIN_SHARE) return undefined;
    const idleMs = request.at - previous.at;
    const isModelSwitch = Boolean(
        request.model && previous.model && request.model !== previous.model,
    );
    const kind: CacheBreakKind = request.afterCompaction
        ? 'compaction'
        : isModelSwitch
          ? 'model'
          : idleMs > ttlMinutes * 60_000
            ? 'ttl'
            : 'prefix';
    return {
        index,
        at: request.at,
        kind,
        expected,
        kept: request.cacheRead,
        rewritten: request.cacheWrite,
        ...(request.cacheWriteUsd !== undefined && { rewriteUsd: request.cacheWriteUsd }),
        idleMs,
        ttlMinutes,
        ...(isModelSwitch && { fromModel: previous.model, toModel: request.model }),
        changes: changes.filter(
            (change) =>
                change.at > previous.at && change.at <= request.at + CHANGE_ATTRIBUTION_SLACK_MS,
        ),
    };
}

/**
 * The prompt cache's state right now, from when the latest response arrived and the lifetime it was written with.
 */
export function cacheClock(
    lastResponseAt: number | undefined,
    ttlMinutes: number,
    now: number,
): { state: 'warm' | 'expired'; remainingMs: number; idleMs: number } | undefined {
    if (lastResponseAt === undefined) return undefined;
    const idleMs = Math.max(0, now - lastResponseAt);
    const remainingMs = ttlMinutes * 60_000 - idleMs;
    return { state: remainingMs > 0 ? 'warm' : 'expired', remainingMs, idleMs };
}
