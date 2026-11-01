import type { AgentChatItem } from '../agent-chat-contract.js';
import {
    MAX_AGENT_CHAT_WEB_SOURCE_TITLE_LENGTH,
    MAX_AGENT_CHAT_WEB_SOURCE_URL_LENGTH,
    MAX_AGENT_CHAT_WEB_SOURCES,
} from '../agent-chat-limits.js';
import { describeAgentTool, parseAgentMcpToolName } from '../agent-tool-presentation.js';
import type { AgentChatWebSource } from './agent-chat-web-source-schema.js';

/**
 * The fields of a tool call its sources are read from: what it was called and the arguments it was given.
 */
interface WebToolCall {
    name: string;
    summary?: string;
    input?: string;
}

/**
 * MCP tools that reach the web, judged by the tool's own name (`web_search_exa`, `fetch`, `crawling`), since an MCP
 * server declares no kind.
 */
const MCP_WEB_TOOL = /web|search|fetch|crawl|scrape/iu;

const URL_PATTERN = /https?:\/\/[^\s"'<>`\\)\]]+/giu;

/**
 * Claude Code's `WebSearch` result opens with its links as one JSON array: `Links: [{"title":…,"url":…}]`.
 */
const CLAUDE_LINKS_PATTERN = /^Links: (\[.*\])$/mu;

/**
 * A search MCP's result entries (Exa and others): a `Title:` line followed by a `URL:` line.
 */
const TITLED_URL_PATTERN = /^Title: (.+)\r?\nURL: (\S+)/gmu;

/**
 * Whether a tool call reaches the web: a built-in web tool (`WebSearch`, `WebFetch`, Codex's `webSearch`) or an MCP
 * tool named for it.
 */
function isAgentChatWebTool(tool: Pick<WebToolCall, 'name' | 'summary'>): boolean {
    const { kind } = describeAgentTool(tool);
    if (kind === 'web') return true;
    const mcp = parseAgentMcpToolName(tool.name);
    return mcp !== null && MCP_WEB_TOOL.test(mcp.tool);
}

/**
 * A web page address as a source keeps it, or undefined for anything that is not an absolute http(s) URL. Trailing
 * sentence punctuation a URL picked up from prose is dropped.
 */
function sourceUrl(raw: string): string | undefined {
    const trimmed = raw.trim().replace(/[.,;:!?]+$/u, '');
    if (trimmed.length > MAX_AGENT_CHAT_WEB_SOURCE_URL_LENGTH) return undefined;
    try {
        const url = new URL(trimmed);
        return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : undefined;
    } catch {
        return undefined;
    }
}

function claudeLinks(result: string): Array<{ url: string; title?: string }> {
    const json = CLAUDE_LINKS_PATTERN.exec(result)?.[1];
    if (!json) return [];
    try {
        const links: unknown = JSON.parse(json);
        if (!Array.isArray(links)) return [];
        return links.flatMap((link: unknown) => {
            if (typeof link !== 'object' || link === null) return [];
            const { title, url } = link as { title?: unknown; url?: unknown };
            if (typeof url !== 'string') return [];
            return [{ url, ...(typeof title === 'string' && { title }) }];
        });
    } catch {
        return [];
    }
}

/**
 * The pages a web tool call searched or fetched, in order and without duplicates: the results a search listed (Claude
 * Code's `Links:` array, or `Title:`/`URL:` entries) and the addresses its arguments named (a fetch's URL). Loose URLs
 * inside a fetched page's text are not sources, so the result is read only for those structured lists. Empty for a tool
 * that does not reach the web.
 */
export function readAgentChatWebSources(
    tool: WebToolCall,
    result: string | undefined,
): AgentChatWebSource[] {
    if (!isAgentChatWebTool(tool)) return [];
    const candidates: Array<{ url: string; title?: string }> = [];
    for (const argument of [tool.summary, tool.input]) {
        if (!argument) continue;
        for (const match of argument.matchAll(URL_PATTERN)) candidates.push({ url: match[0] });
    }
    if (result) {
        candidates.push(...claudeLinks(result));
        for (const match of result.matchAll(TITLED_URL_PATTERN))
            candidates.push({ url: match[2], title: match[1] });
    }
    const sources = new Map<string, AgentChatWebSource>();
    for (const candidate of candidates) {
        const url = sourceUrl(candidate.url);
        if (!url) continue;
        const title = candidate.title?.trim().slice(0, MAX_AGENT_CHAT_WEB_SOURCE_TITLE_LENGTH);
        const known = sources.get(url);
        // An argument names the page first; the search result that also lists it supplies its title.
        if (known) {
            if (title && !known.title) known.title = title;
            continue;
        }
        if (sources.size >= MAX_AGENT_CHAT_WEB_SOURCES) continue;
        sources.set(url, { url, ...(title && { title }) });
    }
    return Array.from(sources.values());
}

/**
 * Every page the given items' web tools searched or fetched, deduplicated by address in the order they were reached:
 * the sources a turn's reply lists. A tool call the Server gave no `sources` (a history replayed before they were
 * recorded) still counts the address its arguments named.
 */
export function collectAgentChatWebSources(items: readonly AgentChatItem[]): AgentChatWebSource[] {
    const sources = new Map<string, AgentChatWebSource>();
    for (const item of items) {
        if (item.type !== 'toolCall') continue;
        const found = item.sources ?? readAgentChatWebSources(item, undefined);
        for (const source of found) {
            const known = sources.get(source.url);
            if (!known || (source.title && !known.title)) sources.set(source.url, source);
        }
    }
    return Array.from(sources.values());
}
