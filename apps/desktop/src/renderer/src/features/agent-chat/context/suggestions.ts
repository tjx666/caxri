import type { AgentChatContextChange, AgentChatContextComposition } from '@caxri/protocol';
import { formatPercent, formatTokens, formatUsd } from '@caxri/protocol';
import { maxBy, sumBy } from 'es-toolkit';

import type { Translate } from '../../../i18n';
import { localizedDuration } from '../../../lib/usage-format';
import type { CacheAnalysis, CacheBreak } from './cache-analysis';
import { mcpServerUsage, messageTokens, messageToolUsage } from './composition';

/**
 * An MCP server whose schemas take this many tokens of every request is worth a look; Claude Code's own `/context`
 * flags MCP tools past 25k in total, and one server past 10k is most of the way there.
 */
const HEAVY_MCP_SERVER_TOKENS = 10_000;

/**
 * A memory file this large is read into every request; the size where Claude Code starts suggesting to move detail into
 * skills.
 */
const LARGE_MEMORY_FILE_TOKENS = 5_000;

/**
 * One tool's results holding this share of the conversation (and at least {@link HEAVY_TOOL_MIN_TOKENS}) is what a
 * compaction would mostly reclaim.
 */
const HEAVY_TOOL_SHARE = 0.3;
const HEAVY_TOOL_MIN_TOKENS = 20_000;

/**
 * Share of the window past which compacting is worth suggesting. Matches the meter's `--warning` step, where answer
 * quality starts to degrade.
 */
const HIGH_CONTEXT_SHARE = 0.6;

export interface ContextSuggestion {
    id: string;
    tone: 'info' | 'warning';
    text: string;
}

/**
 * The Context tab's suggestions: concrete, measured reasons the context is larger or costlier than it needs to be,
 * heaviest first, each naming what to change.
 */
export function contextSuggestions(
    t: Translate,
    composition: AgentChatContextComposition | undefined,
    analysis: CacheAnalysis,
): ContextSuggestion[] {
    const suggestions: ContextSuggestion[] = [];
    const prefixMisses = analysis.breaks.filter((item) => item.kind === 'prefix');
    const prefixMissTokens = sumBy(prefixMisses, (item) => item.rewritten);
    if (prefixMisses.length > 0)
        suggestions.push({
            id: 'prefix-misses',
            tone: 'warning',
            text: t('agentChat.contextPage.suggestion.prefixMisses', {
                count: prefixMisses.length,
                tokens: formatTokens(prefixMissTokens),
            }),
        });
    if (!composition) return suggestions;
    if (
        composition.window > 0 &&
        composition.totalTokens / composition.window >= HIGH_CONTEXT_SHARE
    )
        suggestions.push({
            id: 'context-high',
            tone: 'warning',
            text: t('agentChat.contextPage.suggestion.contextHigh', {
                percent: formatPercent(composition.totalTokens / composition.window),
            }),
        });
    const messages = messageTokens(composition.messages);
    const heaviestTool = maxBy(messageToolUsage(composition), (tool) => tool.resultTokens);
    if (
        heaviestTool &&
        heaviestTool.resultTokens >= HEAVY_TOOL_MIN_TOKENS &&
        heaviestTool.resultTokens / messages >= HEAVY_TOOL_SHARE
    )
        suggestions.push({
            id: 'tool-results',
            tone: 'info',
            text: t('agentChat.contextPage.suggestion.toolResults', {
                tool: heaviestTool.name,
                tokens: formatTokens(heaviestTool.resultTokens),
                percent: formatPercent(heaviestTool.resultTokens / messages),
            }),
        });
    for (const server of mcpServerUsage(composition))
        if (server.tokens >= HEAVY_MCP_SERVER_TOKENS)
            suggestions.push({
                id: `mcp:${server.server}`,
                tone: 'info',
                text: t('agentChat.contextPage.suggestion.mcpServer', {
                    server: server.server,
                    tokens: formatTokens(server.tokens),
                    count: server.loadedCount,
                }),
            });
    for (const file of composition.memoryFiles)
        if (file.tokens >= LARGE_MEMORY_FILE_TOKENS)
            suggestions.push({
                id: `memory:${file.path}`,
                tone: 'info',
                text: t('agentChat.contextPage.suggestion.memoryFile', {
                    file: fileName(file.path),
                    tokens: formatTokens(file.tokens),
                }),
            });
    const { skills } = composition;
    if (skills && skills.included < skills.total)
        suggestions.push({
            id: 'skills-truncated',
            tone: 'info',
            text: t('agentChat.contextPage.suggestion.skillsTruncated', {
                included: skills.included,
                total: skills.total,
            }),
        });
    return suggestions;
}

/**
 * One sentence on why a request rewrote the cache, in the terms of the Anthropic API's cache diagnostics: whether the
 * request changed or the cache simply expired.
 */
export function cacheBreakReason(t: Translate, item: CacheBreak): string {
    switch (item.kind) {
        case 'compaction': {
            return t('agentChat.contextPage.break.compaction');
        }
        case 'model': {
            return t('agentChat.contextPage.break.model', {
                from: item.fromModel ?? '',
                to: item.toModel ?? '',
            });
        }
        case 'ttl': {
            return t('agentChat.contextPage.break.ttl', {
                idle: localizedDuration(item.idleMs, t),
                ttl: localizedDuration(item.ttlMinutes * 60_000, t),
            });
        }
        case 'prefix': {
            return item.changes.length > 0
                ? t('agentChat.contextPage.break.prefixChanged', {
                      changes: item.changes
                          .map((change) => contextChangeText(t, change))
                          .join('; '),
                  })
                : t('agentChat.contextPage.break.prefix');
        }
    }
}

const CHANGE_NAMES_SHOWN = 3;

export function contextChangeText(t: Translate, change: AgentChatContextChange): string {
    const shown = change.names.slice(0, CHANGE_NAMES_SHOWN).map((name) => fileName(name));
    const more = change.names.length - shown.length;
    const names =
        shown.join(', ') +
        (more > 0 ? t('agentChat.contextPage.change.more', { count: more }) : '');
    const delta =
        change.tokenDelta === undefined
            ? ''
            : `${change.tokenDelta > 0 ? '+' : '−'}${formatTokens(Math.abs(change.tokenDelta))}`;
    return t(`agentChat.contextPage.change.${change.kind}`, { names, delta });
}

/**
 * A rewrite's price as the page prints it, or nothing when the model has no price.
 */
export function rewriteCost(usd: number | undefined): string | undefined {
    return usd === undefined || usd <= 0 ? undefined : `~${formatUsd(usd)}`;
}

/**
 * The last path segment, for memory files and other paths quoted in a sentence; a name without a separator stays whole.
 */
export function fileName(path: string): string {
    const name = path.slice(path.lastIndexOf('/') + 1);
    return name === '' ? path : name;
}
