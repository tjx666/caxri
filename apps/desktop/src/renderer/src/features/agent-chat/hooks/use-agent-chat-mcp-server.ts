import { createContext, useContext, useMemo } from 'react';

import type { AgentChatMcpServer } from '@caxri/protocol';
import { parseAgentMcpToolName } from '@caxri/protocol';

/**
 * The MCP servers a Chat's tool calls named, keyed by server name (the snapshot's `mcpServers`). Provided by the Chat
 * pane; a task tab's read-only timeline provides nothing, so its MCP rows keep the generic glyph.
 */
export const AgentChatMcpServersContext = createContext<
    ReadonlyMap<string, AgentChatMcpServer> | undefined
>(undefined);

/**
 * What the Chat pane provides, memoized on the server list so a streamed delta does not re-render every memoized row.
 */
export function useAgentChatMcpServers(
    servers: readonly AgentChatMcpServer[] | undefined,
): ReadonlyMap<string, AgentChatMcpServer> | undefined {
    return useMemo(
        () => (servers ? new Map(servers.map((server) => [server.name, server])) : undefined),
        [servers],
    );
}

/**
 * The server an MCP tool call (`mcp__exa__web_search_exa`, `exa/web_search_exa`) belongs to, once the provider
 * described it.
 */
export function useAgentChatMcpServer(
    toolName: string | undefined,
): AgentChatMcpServer | undefined {
    const servers = useContext(AgentChatMcpServersContext);
    const server = toolName === undefined ? undefined : parseAgentMcpToolName(toolName)?.server;
    return server === undefined ? undefined : servers?.get(server);
}
