import type { AgentChatItem } from '../agent-chat-contract.js';
import { parseAgentMcpToolName } from '../agent-tool-presentation.js';
import type {
    AgentChatTrackerArtifact,
    AgentChatTrackerStatus,
    AgentChatTrackerStatusType,
    Json,
} from './agent-chat-tracker-artifact.js';
import {
    AGENT_CHAT_TRACKER_STATUS_TYPES,
    agentChatTrackerExcerpt,
    GITHUB_URL,
    githubUrlArtifact,
    isRecord,
    LINEAR_URL,
    parseJsonRecord,
    stringOf,
} from './agent-chat-tracker-artifact.js';

type ToolCallItem = Extract<AgentChatItem, { type: 'toolCall' }>;

/**
 * The record that describes the issue or pull request: the result itself, or one level down when the server wraps it
 * (`{ "issue": { ... } }`).
 */
function trackerRecord(result: Json | undefined): Json | undefined {
    if (!result) return undefined;
    if (stringOf(result.url) ?? stringOf(result.html_url)) return result;
    return Object.values(result).find(
        (value): value is Json =>
            isRecord(value) && Boolean(stringOf(value.url) ?? stringOf(value.html_url)),
    );
}

/**
 * Which tracker operation an MCP tool performs, from its tool name: the official GitHub MCP server's
 * `create_pull_request`, `update_pull_request`, `create_issue`, `update_issue`, and `issue_write`, and the Linear MCP
 * server's `create_issue`, `update_issue`, and `save_issue`.
 */
function mcpOperation(
    name: string,
): { provider: AgentChatTrackerArtifact['provider']; tool: string } | undefined {
    const mcp = parseAgentMcpToolName(name);
    if (!mcp) return undefined;
    const server = mcp.server.toLowerCase();
    const tool = mcp.tool.toLowerCase();
    if (server.includes('linear') && /^(?:create|update|save)_issue$/u.test(tool))
        return { provider: 'linear', tool };
    if (
        server.includes('github') &&
        /^(?:(?:create|update)_(?:pull_request|issue)|issue_write)$/u.test(tool)
    )
        return { provider: 'github', tool };
    return undefined;
}

/**
 * Linear's `save_issue` both creates and updates. An `id` in the arguments targets an existing issue; otherwise a
 * result updated well after it was created is an edit of an older issue.
 */
function isLinearSaveUpdate(arguments_: Json | undefined, record: Json | undefined): boolean {
    if (stringOf(arguments_?.id)) return true;
    const created = Date.parse(stringOf(record?.createdAt) ?? '');
    const updated = Date.parse(stringOf(record?.updatedAt) ?? '');
    return Number.isFinite(created) && Number.isFinite(updated) && updated - created > 60_000;
}

function trackerStatusType(value: unknown): AgentChatTrackerStatusType | undefined {
    return AGENT_CHAT_TRACKER_STATUS_TYPES.find((type) => type === value);
}

/**
 * The issue's state after a Linear MCP call. The official server flattens it to `status` and `statusType`; a GraphQL
 * shaped result nests it as `state: { name, type }`. When the result names neither, the `state` the Agent asked for
 * still says where the issue went, without its category.
 */
function linearStatus(
    record: Json | undefined,
    arguments_: Json | undefined,
): AgentChatTrackerStatus | undefined {
    const nested = isRecord(record?.state) ? record.state : undefined;
    const name =
        stringOf(record?.status) ??
        stringOf(nested?.name) ??
        stringOf(record?.state) ??
        stringOf(arguments_?.state);
    if (!name) return undefined;
    const type = trackerStatusType(record?.statusType ?? nested?.type);
    return type ? { name, type } : { name };
}

function mcpAction(
    tool: string,
    arguments_: Json | undefined,
    record: Json | undefined,
): AgentChatTrackerArtifact['action'] {
    if (tool.startsWith('create_')) return 'created';
    if (tool.startsWith('update_')) return 'updated';
    if (tool === 'issue_write') return arguments_?.method === 'update' ? 'updated' : 'created';
    return isLinearSaveUpdate(arguments_, record) ? 'updated' : 'created';
}

/**
 * A GitHub or Linear MCP call that created or edited an issue or pull request. The result names the URL, title, and
 * body; arguments fill in what the result left out. Claude Code summarizes arguments by one field rather than as JSON,
 * so they are read only when the summary parses.
 */
export function toolCallTrackerArtifact(item: ToolCallItem): AgentChatTrackerArtifact | undefined {
    if (item.status !== 'completed') return undefined;
    const operation = mcpOperation(item.name);
    if (!operation) return undefined;
    const arguments_ = parseJsonRecord(item.summary);
    const record = trackerRecord(parseJsonRecord(item.output));
    const title = stringOf(record?.title) ?? stringOf(arguments_?.title);
    const excerpt = agentChatTrackerExcerpt(
        stringOf(record?.body) ??
            stringOf(record?.description) ??
            stringOf(arguments_?.body) ??
            stringOf(arguments_?.description),
    );
    const action = mcpAction(operation.tool, arguments_, record);
    const details = { action, ...(title && { title }), ...(excerpt && { excerpt }) };
    if (operation.provider === 'github') {
        const url =
            stringOf(record?.html_url) ??
            Array.from((item.output ?? '').matchAll(GITHUB_URL)).at(-1)?.[0];
        const target = url && githubUrlArtifact(url);
        if (!target) return undefined;
        return { provider: 'github', ...target, ...details };
    }
    const linearUrl = Array.from((item.output ?? '').matchAll(LINEAR_URL)).at(-1);
    const url = stringOf(record?.url) ?? linearUrl?.[0];
    const identifier =
        stringOf(record?.identifier) ?? (url && Array.from(url.matchAll(LINEAR_URL)).at(0)?.[1]);
    if (!url || !identifier) return undefined;
    const status = linearStatus(record, arguments_);
    return {
        provider: 'linear',
        kind: 'issue',
        url,
        reference: identifier,
        ...details,
        ...(status && { status }),
    };
}
