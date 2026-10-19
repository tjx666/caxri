import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentChatSnapshot, AgentChatUsage } from '@caxri/protocol';
import { MAX_AGENT_CHAT_USAGE_BREAKDOWN } from '@caxri/protocol';

import { clip, isRecord, stringField } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';
import { withCacheRewriteEstimate } from './chat-usage';
import { claudeUsageTokens } from './claude-items';
import { withTimeout } from './claude-prompt-queue';

const CONTEXT_USAGE_TIMEOUT_MS = 5_000;

/**
 * Claude Code writes the prompt cache with a one-hour lifetime for subscribers and a five-minute one otherwise. A
 * response that wrote no cache says nothing about which applies, so the Chat keeps what it learned before and assumes
 * the hour until a write shows otherwise.
 *
 * @see https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration
 */
const DEFAULT_CLAUDE_CACHE_TTL_MINUTES = 60;

/**
 * The cache lifetime a response's `usage.cache_creation` split reveals: any one-hour write means the hour, otherwise
 * any five-minute write means five minutes.
 */
export function claudeCacheTtlMinutes(usage: unknown): 5 | 60 | undefined {
    const creation = isRecord(usage) ? usage.cache_creation : undefined;
    if (!isRecord(creation)) return undefined;
    if (isPositive(creation.ephemeral_1h_input_tokens)) return 60;
    if (isPositive(creation.ephemeral_5m_input_tokens)) return 5;
    return undefined;
}

/**
 * The usage one assistant response reports, or `undefined` when it carries no token count. The previous breakdown stays
 * until a context refresh replaces it, so an open context meter keeps its rows instead of collapsing to the total for
 * every response of a running turn.
 */
export function claudeResponseUsage(
    message: Record<string, unknown>,
    snapshot: Pick<AgentChatSnapshot, 'model' | 'usage'>,
    contextWindow: number | undefined,
): AgentChatUsage | undefined {
    const totalTokens = claudeUsageTokens(message.usage);
    if (totalTokens === undefined) return undefined;
    const { autoCompactThreshold, breakdown, compactWindow, cacheTtlMinutes } =
        snapshot.usage ?? {};
    return withCacheRewriteEstimate(
        {
            totalTokens,
            ...(contextWindow && { contextWindow }),
            ...(breakdown && { breakdown }),
            ...(compactWindow && { compactWindow }),
            ...(autoCompactThreshold && { autoCompactThreshold }),
            cacheTtlMinutes:
                claudeCacheTtlMinutes(message.usage) ??
                cacheTtlMinutes ??
                DEFAULT_CLAUDE_CACHE_TTL_MINUTES,
            lastResponseAt: Date.now(),
        },
        stringField(message.model) ?? snapshot.model,
    );
}

/**
 * The parts of `getContextUsage` the context meter shows: the rows that occupy the window, and the window Claude Code
 * compacts against when it is smaller than the model's own. Free space and out-of-window (deferred) tool schemas are
 * left out; the autocompact reserve stays, since it is part of what fills the window before compaction. A report with
 * auto-compact turned off names no compaction window: the meter's card would otherwise promise an automatic compaction
 * the Context tab (which reads the same flag) says is off. A report without the flag, from an older Claude Code, keeps
 * the window.
 */
export function claudeContextDetails(
    response: unknown,
    contextWindow: number | undefined,
): Pick<AgentChatUsage, 'autoCompactThreshold' | 'breakdown' | 'compactWindow'> {
    if (!isRecord(response)) return {};
    const categories = Array.isArray(response.categories) ? response.categories : [];
    const breakdown = categories
        .flatMap((category) => {
            if (!isRecord(category)) return [];
            const label = stringField(category.name);
            const tokens = category.tokens;
            const isInWindow = category.kind === 'used' || category.kind === 'buffer';
            return label && isInWindow && isPositive(tokens)
                ? [{ label: clip(label, 80), tokens: Math.trunc(tokens) }]
                : [];
        })
        .slice(0, MAX_AGENT_CHAT_USAGE_BREAKDOWN);
    const window = response.rawMaxTokens;
    const compactWindow =
        response.isAutoCompactEnabled !== false &&
        isPositive(window) &&
        (contextWindow === undefined || window < contextWindow)
            ? Math.trunc(window)
            : undefined;
    const threshold = response.autoCompactThreshold;
    const autoCompactThreshold =
        response.isAutoCompactEnabled !== false && isPositive(threshold)
            ? Math.trunc(threshold)
            : undefined;
    return {
        ...(breakdown.length > 0 && { breakdown }),
        ...(compactWindow !== undefined && { compactWindow }),
        ...(autoCompactThreshold !== undefined && { autoCompactThreshold }),
    };
}

/**
 * Coalesces context refreshes: Claude Code answers `get_context_usage` while a turn runs, so every response asks for
 * the rows that fill its new total. At most one request is in flight; requests made meanwhile collapse into one more.
 */
export class ClaudeContextRefresh {
    private isRunning = false;

    private isRequestedAgain = false;

    constructor(private readonly refresh: () => Promise<void>) {}

    private async run(): Promise<void> {
        try {
            await this.refresh();
        } catch {
            // The meter keeps its total without the rows.
        }
        this.isRunning = false;
        if (this.isRequestedAgain) this.request();
    }

    request(): void {
        if (this.isRunning) {
            this.isRequestedAgain = true;
            return;
        }
        this.isRunning = true;
        this.isRequestedAgain = false;
        // eslint-disable-next-line no-void -- best effort; the context meter keeps its total without it
        void this.run();
    }
}

/**
 * Asks Claude Code what fills the context, during a turn and once it ends. `summary` answers from local estimates
 * without extra token-count requests. A newer response that changed the total in the meantime wins, so the rows never
 * describe an older context; a failure leaves the meter with its total alone.
 */
export async function refreshClaudeContextDetails(
    query: Pick<Query, 'getContextUsage'>,
    host: Pick<AgentChatSessionHost, 'apply' | 'read'>,
    isEnded: () => boolean,
    onAnswer?: (response: unknown) => void,
): Promise<void> {
    const before = host.read().usage;
    if (!before) return;
    let response: unknown;
    try {
        response = await readClaudeContextUsage(query);
    } catch {
        return;
    }
    onAnswer?.(response);
    const usage = host.read().usage;
    if (isEnded() || usage?.totalTokens !== before.totalTokens) return;
    // The previous rows were kept only until this answer; an answer without rows drops them.
    const details = claudeContextDetails(response, usage.contextWindow);
    const next = { ...usage, ...details };
    if (next.breakdown === usage.breakdown) delete next.breakdown;
    // A threshold from an earlier answer must not outlive auto-compact being turned off.
    if (details.autoCompactThreshold === undefined) delete next.autoCompactThreshold;
    host.apply([{ op: 'state', state: { usage: next } }]);
}

/**
 * One `get_context_usage` answer, bounded so a stalled process cannot hold the caller.
 */
export function readClaudeContextUsage(query: Pick<Query, 'getContextUsage'>): Promise<unknown> {
    return withTimeout(query.getContextUsage({ detail: 'summary' }), CONTEXT_USAGE_TIMEOUT_MS);
}

function isPositive(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
