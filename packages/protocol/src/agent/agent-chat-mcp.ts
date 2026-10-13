import { z } from 'zod';

/**
 * MCP servers a Chat's tool calls named; one entry per server the provider described.
 */
export const MAX_AGENT_CHAT_MCP_SERVERS = 50;

/**
 * An icon a server ships inline as a data URL is read only up to this length, so one server cannot bloat every
 * snapshot; a larger one is dropped and the row falls back to the server's site icon.
 */
export const MAX_AGENT_CHAT_MCP_ICON_SRC_LENGTH = 24 * 1024;

const httpsOriginSchema = z
    .string()
    .max(2048)
    .regex(/^https:\/\/[^\s#/?@]+$/u);

/**
 * One icon a server advertised in its MCP `serverInfo.icons` (protocol revision 2025-11-25), already narrowed by Server
 * Core to at most one per theme. `theme` names the background the icon is drawn for: `dark` for a dark UI.
 */
export const agentChatMcpIconSchema = z.strictObject({
    src: z
        .string()
        .max(MAX_AGENT_CHAT_MCP_ICON_SRC_LENGTH)
        .regex(/^(?:https:\/\/[^\s#@]+|data:image\/[\w.+-]+;base64,[\w+/=]+)$/u),
    theme: z.enum(['light', 'dark']).optional(),
});

/**
 * What a Chat shows for one MCP server, keyed by the server name its tool calls carry (`mcp__<name>__<tool>` or
 * `<name>/<tool>`). `siteOrigins` are HTTPS origins whose `/favicon.ico` stands in, in order, when no advertised icon
 * loads: the server's declared website, then its endpoint and the endpoint's parent domain, because an MCP endpoint
 * host (`mcp.example.com`) rarely serves an icon of its own.
 */
export const agentChatMcpServerSchema = z.strictObject({
    name: z.string().min(1).max(200),
    title: z.string().max(200).optional(),
    icons: z.array(agentChatMcpIconSchema).max(3).optional(),
    siteOrigins: z.array(httpsOriginSchema).max(3).optional(),
});

export type AgentChatMcpIcon = z.infer<typeof agentChatMcpIconSchema>;
export type AgentChatMcpServer = z.infer<typeof agentChatMcpServerSchema>;

/**
 * An MCP tool identifier as a title, the way the Codex app names a tool without a title of its own: `web_search_exa`
 * reads `Web search exa`.
 */
export function agentChatMcpToolTitle(tool: string): string {
    const words = tool.replaceAll(/[_-]+/gu, ' ').trim();
    return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : tool;
}
