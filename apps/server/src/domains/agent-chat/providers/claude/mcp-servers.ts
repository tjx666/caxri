import type { McpServerStatus, Query } from '@anthropic-ai/claude-agent-sdk';

import type { McpServerReport } from '../../chat-mcp-servers';
import { withTimeout } from './prompt-queue';

/**
 * An MCP status read only decorates the timeline; one that hangs leaves the row on its generic glyph.
 */
const MCP_STATUS_TIMEOUT_MS = 10_000;

/**
 * Claude Code names an MCP tool `mcp__<server>__<tool>` after the configured server name with every character outside
 * `[A-Za-z0-9_-]` replaced, so a claude.ai connector named `claude.ai Exa` calls tools as `mcp__claude_ai_Exa__...`.
 */
const toolServerName = (name: string): string => name.replaceAll(/[^\w-]/gu, '_');

/**
 * The status entry behind a tool call's server name, as a {@link McpServerReport}. The SDK types `serverInfo` as only a
 * name and version, but Claude Code passes on the server's whole MCP `initialize` identity, so a title, website, and
 * icons are read when present. A claude.ai connector's endpoint is Anthropic's proxy, whose icon is not the server's,
 * so it offers no site to fall back on.
 */
export function claudeMcpServerReport(
    statuses: readonly McpServerStatus[],
    name: string,
): McpServerReport | undefined {
    const status =
        statuses.find((entry) => entry.name === name) ??
        statuses.find((entry) => toolServerName(entry.name) === name);
    if (!status) return undefined;
    const serverInfo: Record<string, unknown> = { ...status.serverInfo };
    const { config } = status;
    const endpointUrl =
        config && config.type !== 'claudeai-proxy' && 'url' in config ? config.url : undefined;
    return {
        title: serverInfo.title,
        icons: serverInfo.icons,
        websiteUrl: serverInfo.websiteUrl,
        endpointUrl,
        isConnected: status.status === 'connected',
    };
}

export async function readClaudeMcpServer(
    query: Query,
    name: string,
): Promise<McpServerReport | undefined> {
    const statuses = await withTimeout(query.mcpServerStatus(), MCP_STATUS_TIMEOUT_MS);
    return claudeMcpServerReport(statuses, name);
}
