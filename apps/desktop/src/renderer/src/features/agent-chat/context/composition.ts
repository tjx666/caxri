import type { AgentChatContextComposition, AgentChatUsage } from '@caxri/protocol';
import { formatTokens } from '@caxri/protocol';

import { agentChatContextLimit, agentChatContextPercent } from './agent-chat-context';

type Category = AgentChatContextComposition['categories'][number];

/**
 * Where a `/context` row sits in the request Claude Code sends: tool schemas first, then the system prompt, then the
 * messages, which open with the memory files and the skill listing. The prompt cache is a prefix over exactly this
 * order, so drawing the window in it lets a cache break point at the part where the rewrite began. Rows Claude Code
 * adds later fall between the system prompt and the messages, which is where its newer context rows have landed.
 */
const REQUEST_ORDER: Record<string, number> = {
    'System tools': 0,
    'MCP tools': 1,
    'Custom agents': 2,
    'System prompt': 3,
    'MCP server instructions': 4,
    'Memory files': 6,
    'Skills': 7,
    'Messages': 9,
    // The two compaction reserves, by name, for the composer meter's rows, which carry no `kind`.
    'Autocompact buffer': 30,
    'Compact buffer': 30,
};
const UNKNOWN_ROW_ORDER = 5;
const FREE_ROW_ORDER = 20;
const BUFFER_ROW_ORDER = 30;

/**
 * Sort key of a `/context` row in request order; the free space and then the autocompact reserve close the window.
 */
function contextRowRank(label: string, kind?: Category['kind']): number {
    if (kind === 'free') return FREE_ROW_ORDER;
    if (kind === 'buffer') return BUFFER_ROW_ORDER;
    return REQUEST_ORDER[label] ?? UNKNOWN_ROW_ORDER;
}

/**
 * Rows in request order, keeping the provider's order among rows of equal rank.
 */
export function inRequestOrder<T extends { label: string; kind?: Category['kind'] }>(
    rows: readonly T[],
): T[] {
    return rows
        .map((row, index) => ({ row, index }))
        .toSorted(
            (a, b) =>
                contextRowRank(a.row.label, a.row.kind) - contextRowRank(b.row.label, b.row.kind) ||
                a.index - b.index,
        )
        .map(({ row }) => row);
}

/**
 * Shades for the window's content rows in request order: opacity steps of the one `--chart` role, as DESIGN.md asks of
 * every quantity series, so each row's swatch matches its segment and a theme retunes them all at once. The steps
 * alternate and repeat instead of fading out, so neighbors always contrast and the last row (the messages, usually the
 * largest) never fades into the free-space track at `--chart/10`. The composer meter and the Context tab draw the same
 * rows in the same order, so a row keeps its shade across both.
 */
const SEGMENT_SHADES = [
    'bg-chart',
    'bg-chart/65',
    'bg-chart/40',
    'bg-chart/85',
    'bg-chart/55',
    'bg-chart/30',
];

/**
 * The compaction reserve is not content, so it stays neutral rather than taking a `--chart` step.
 */
const BUFFER_SHADE = 'bg-muted/35';

export function segmentShade(
    row: { label: string; kind?: Category['kind'] },
    index: number,
): string {
    return contextRowRank(row.label, row.kind) === BUFFER_ROW_ORDER
        ? BUFFER_SHADE
        : SEGMENT_SHADES[index % SEGMENT_SHADES.length];
}

/**
 * Where Claude Code compacts this conversation on its own, or `undefined` while its auto-compact is off. A report with
 * auto-compact on but no threshold (an older Claude Code) compacts against its window, the same figure the composer
 * meter's card names, so the Context tab never reads `Auto-compact off` beside a card promising a compaction.
 */
export function autoCompactAt(composition: AgentChatContextComposition): number | undefined {
    if (!composition.isAutoCompactEnabled) return undefined;
    const at = composition.autoCompactThreshold ?? composition.window;
    return at > 0 ? at : undefined;
}

/**
 * The Context tile's figures: `used / limit` and the share of that limit, measured against the auto-compact threshold
 * when Claude Code reports one (the same denominator the composer's meter uses), else the window. `/context` results
 * win over the last turn's usage because they are newer.
 */
export function contextTileFigures(
    composition: AgentChatContextComposition | undefined,
    usage: AgentChatUsage | undefined,
): { value?: string; percent?: number; threshold?: number } {
    const total = composition?.totalTokens ?? usage?.totalTokens;
    if (total === undefined) return {};
    const threshold = composition ? autoCompactAt(composition) : usage?.autoCompactThreshold;
    const baseWindow = composition?.window ?? usage?.compactWindow ?? usage?.contextWindow;
    const limit = baseWindow ? agentChatContextLimit(baseWindow, threshold) : undefined;
    if (!limit) return { value: formatTokens(total) };
    return {
        value: `${formatTokens(total)} / ${formatTokens(limit)}`,
        percent: agentChatContextPercent(total, limit),
        ...(threshold !== undefined && { threshold }),
    };
}

export interface ContextSegment extends Category {
    /**
     * Tokens before this row in the request, so `[offset, offset + tokens)` is the span it occupies in the prompt.
     */
    offset: number;
}

/**
 * The window's rows in request order: the content that fills it, then the free space, then the autocompact reserve.
 * Deferred tool schemas are outside the window until loaded, so they get no span.
 */
export function contextWindowSegments(composition: AgentChatContextComposition): ContextSegment[] {
    const rows = inRequestOrder(
        composition.categories.filter((row) => row.kind !== 'deferred' && row.tokens > 0),
    );
    let offset = 0;
    return rows.map((row) => {
        const segment = { ...row, offset };
        offset += row.tokens;
        return segment;
    });
}

/**
 * The row of the prompt that holds token `offset`, and how far into that row it falls (0 to 1). A cache break that kept
 * `offset` tokens rewrote everything from there on. Past the last content row the offset lands at the end of the
 * messages, which is where a turn's new tokens go.
 */
export function promptSegmentAt(
    segments: readonly ContextSegment[],
    offset: number,
): { label: string; progress: number } | undefined {
    const content = segments.filter((segment) => segment.kind === 'used');
    const hit = content.find((segment) => offset < segment.offset + segment.tokens);
    if (hit) return { label: hit.label, progress: (offset - hit.offset) / hit.tokens };
    const last = content.at(-1);
    return last && { label: last.label, progress: 1 };
}

export interface McpServerUsage {
    server: string;
    /**
     * Tokens of the schemas in the window now.
     */
    tokens: number;
    /**
     * Tokens of the schemas that load only when the model searches for them.
     */
    deferredTokens: number;
    loadedCount: number;
    tools: AgentChatContextComposition['mcpTools'];
}

/**
 * MCP tools grouped by server, heaviest in-window server first, each server's tools heaviest first. The `mcp__server__`
 * prefix is dropped from tool names, since the server already heads the group.
 */
export function mcpServerUsage(composition: AgentChatContextComposition): McpServerUsage[] {
    const servers = new Map<string, McpServerUsage>();
    for (const tool of composition.mcpTools) {
        const entry = servers.get(tool.server) ?? {
            server: tool.server,
            tokens: 0,
            deferredTokens: 0,
            loadedCount: 0,
            tools: [],
        };
        if (tool.isLoaded) {
            entry.tokens += tool.tokens;
            entry.loadedCount += 1;
        } else entry.deferredTokens += tool.tokens;
        entry.tools.push({ ...tool, name: mcpToolName(tool.name, tool.server) });
        servers.set(tool.server, entry);
    }
    return servers
        .values()
        .map((entry) => ({ ...entry, tools: entry.tools.toSorted((a, b) => b.tokens - a.tokens) }))
        .toArray()
        .toSorted(
            (a, b) =>
                b.tokens - a.tokens ||
                b.deferredTokens - a.deferredTokens ||
                a.server.localeCompare(b.server),
        );
}

function mcpToolName(name: string, server: string): string {
    const prefix = `mcp__${server}__`;
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export interface MessageToolUsage {
    name: string;
    callTokens: number;
    resultTokens: number;
    tokens: number;
}

/**
 * Tools by what their calls and results occupy in the conversation, heaviest first.
 */
export function messageToolUsage(composition: AgentChatContextComposition): MessageToolUsage[] {
    return (composition.messages?.tools ?? [])
        .map((tool) => ({ ...tool, tokens: tool.callTokens + tool.resultTokens }))
        .filter((tool) => tool.tokens > 0)
        .toSorted((a, b) => b.tokens - a.tokens);
}

/**
 * Total tokens the messages occupy, by the provider's own message breakdown.
 */
export function messageTokens(messages: AgentChatContextComposition['messages']): number {
    if (!messages) return 0;
    return (
        messages.toolCalls +
        messages.toolResults +
        messages.attachments +
        messages.assistant +
        messages.user +
        messages.other
    );
}

/**
 * Heaviest first, then by name, so equal rows keep a stable order across refreshes.
 */
export function byTokens<T extends { tokens: number }>(
    rows: readonly T[],
    name: (row: T) => string,
): T[] {
    return rows.toSorted((a, b) => b.tokens - a.tokens || name(a).localeCompare(name(b)));
}
