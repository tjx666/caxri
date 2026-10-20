import { createContext } from 'react';

import type { AgentChatMcpServer } from '@caxri/protocol';
import { parseAgentMcpToolName } from '@caxri/protocol';

/**
 * The MCP servers a Chat's tool calls named, keyed by server name (the snapshot's `mcpServers`, which carries only
 * titles, site origins, and HTTPS icon URLs for the phone). Provided by the Chat view; absent for a terminal Agent,
 * whose MCP rows keep the connector glyph.
 */
export const AgentChatMcpServersContext = createContext<
    ReadonlyMap<string, AgentChatMcpServer> | undefined
>(undefined);

/**
 * Where to load a server's icon from, in order. The phone's theme is dark, so the icon drawn for a dark background
 * leads, then an unthemed one, then the light one; the sites' `/favicon.ico` come last, as on Desktop. Only HTTPS URLs
 * qualify. The phone requests them directly, and the connector glyph shows while one loads or when none does.
 */
export const agentChatMcpIconUrls = (server: AgentChatMcpServer | undefined): string[] => {
    if (!server) return [];
    const order = ['dark', undefined, 'light'];
    // eslint-disable-next-line unicorn/no-array-sort -- The mobile Hermes target does not support ES2023 toSorted; the copy leaves the snapshot's array alone.
    const icons = [...(server.icons ?? [])].sort(
        (left, right) => order.indexOf(left.theme) - order.indexOf(right.theme),
    );
    const urls = new Set<string>();
    for (const { src } of icons) if (src.startsWith('https://')) urls.add(src);
    const siteOrigins = server.siteOrigins ?? [];
    for (const origin of siteOrigins) urls.add(`${origin}/favicon.ico`);
    return [...urls];
};

/**
 * The server an MCP tool call (`mcp__exa__web_search_exa`, `exa/web_search_exa`) belongs to, once the provider
 * described it.
 */
export const agentChatMcpServerFor = (
    servers: ReadonlyMap<string, AgentChatMcpServer> | undefined,
    toolName: string,
): AgentChatMcpServer | undefined => {
    const server = parseAgentMcpToolName(toolName)?.server;
    return server === undefined ? undefined : servers?.get(server);
};
