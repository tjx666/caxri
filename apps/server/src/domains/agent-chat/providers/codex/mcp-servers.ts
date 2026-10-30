import type { McpServerReport } from '../../chat-mcp-servers';
import type { JsonRpcConnection } from '../../json-rpc-connection';

/**
 * An MCP status read only decorates the timeline; one that hangs leaves the row on its generic glyph.
 */
const MCP_STATUS_TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;

const record = (value: unknown): Json | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Json)
        : undefined;

/**
 * The server a Codex `mcpServerStatus/list` answer describes, as a {@link McpServerReport}. Codex returns the server's
 * MCP `initialize` identity as `serverInfo` and the origin of its HTTP endpoint as `httpOrigin`.
 */
export function codexMcpServerReport(result: unknown, name: string): McpServerReport | undefined {
    const data = record(result)?.data;
    if (!Array.isArray(data)) return undefined;
    const status = data.map(record).find((entry) => entry?.name === name);
    if (!status) return undefined;
    const serverInfo = record(status.serverInfo);
    return {
        title: serverInfo?.title,
        icons: serverInfo?.icons,
        websiteUrl: serverInfo?.websiteUrl,
        endpointUrl: status.httpOrigin,
        isConnected: status.runtimeStatus === 'connected' || serverInfo !== undefined,
    };
}

/**
 * Scoped to the thread and one server, so Codex reuses the connection the thread already holds instead of starting the
 * server again.
 */
export async function readCodexMcpServer(
    connection: JsonRpcConnection | undefined,
    threadId: string | undefined,
    name: string,
): Promise<McpServerReport | undefined> {
    if (!threadId || !connection?.isOpen) return undefined;
    const result = await connection.request(
        'mcpServerStatus/list',
        { threadId, serverName: name, detail: 'full' },
        MCP_STATUS_TIMEOUT_MS,
    );
    return codexMcpServerReport(result, name);
}
