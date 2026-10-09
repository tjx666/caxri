import type { AgentTimelineItem } from '@caxri/protocol';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;

export type ToolKind =
    | 'agent'
    | 'command'
    | 'edit'
    | 'image'
    | 'list'
    | 'mcp'
    | 'other'
    | 'plan'
    | 'question'
    | 'read'
    | 'search'
    | 'skill'
    | 'stop'
    | 'thought'
    | 'web'
    | 'write';

export interface ToolPresentation {
    kind: ToolKind;
    /**
     * Past-tense action shown before the subject, such as `Ran` or `Edited`.
     */
    label: string;
    /**
     * What the tool acted on. Absent when the transcript recorded nothing beyond the tool name.
     */
    subject?: string;
    /**
     * Commands, paths, and patterns render in a monospace chip; prose subjects stay in the body font.
     */
    isCodeSubject: boolean;
}

/**
 * Provider tool names from Claude Code and Codex transcripts. Lookup is case-insensitive because Codex names are
 * snake_case while Claude Code names are PascalCase, and a few overlap in meaning.
 */
const TOOL_KINDS: Partial<Record<string, { kind: ToolKind; label: string }>> = {
    bash: { kind: 'command', label: 'Ran' },
    shell: { kind: 'command', label: 'Ran' },
    exec_command: { kind: 'command', label: 'Ran' },
    local_shell: { kind: 'command', label: 'Ran' },
    bashoutput: { kind: 'command', label: 'Checked output' },
    write_stdin: { kind: 'command', label: 'Sent input' },
    killshell: { kind: 'stop', label: 'Stopped' },
    killbash: { kind: 'stop', label: 'Stopped' },
    read: { kind: 'read', label: 'Read' },
    notebookread: { kind: 'read', label: 'Read' },
    ls: { kind: 'list', label: 'Listed' },
    edit: { kind: 'edit', label: 'Edited' },
    multiedit: { kind: 'edit', label: 'Edited' },
    notebookedit: { kind: 'edit', label: 'Edited' },
    apply_patch: { kind: 'edit', label: 'Patched' },
    write: { kind: 'write', label: 'Wrote' },
    grep: { kind: 'search', label: 'Searched' },
    glob: { kind: 'search', label: 'Found files' },
    toolsearch: { kind: 'search', label: 'Looked up tools' },
    webfetch: { kind: 'web', label: 'Fetched' },
    websearch: { kind: 'web', label: 'Searched the web' },
    web_search: { kind: 'web', label: 'Searched the web' },
    task: { kind: 'agent', label: 'Ran agent' },
    agent: { kind: 'agent', label: 'Ran agent' },
    todowrite: { kind: 'plan', label: 'Updated plan' },
    update_plan: { kind: 'plan', label: 'Updated plan' },
    exitplanmode: { kind: 'plan', label: 'Proposed plan' },
    skill: { kind: 'skill', label: 'Used skill' },
    askuserquestion: { kind: 'question', label: 'Asked' },
    view_image: { kind: 'image', label: 'Viewed image' },
    /**
     * Agent Chat reasoning, projected as a collapsed row whose detail holds the reasoning text.
     */
    reasoning: { kind: 'thought', label: 'Thought' },
};

const FILE_KINDS = new Set<ToolKind>(['edit', 'list', 'read', 'write']);
const PROSE_KINDS = new Set<ToolKind>(['agent', 'question', 'thought', 'web']);

const basename = (path: string): string => {
    const trimmed = path.replace(/[\\/]+$/u, '');
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return index === -1 ? trimmed : trimmed.slice(index + 1) || trimmed;
};

/**
 * MCP tools arrive as `mcp__<server>__<tool>`; the server name reads better than the raw identifier.
 */
const parseMcpName = (name: string): { server: string; tool: string } | null => {
    if (!name.startsWith('mcp__')) return null;
    const rest = name.slice('mcp__'.length);
    const separator = rest.indexOf('__', 1);
    if (separator === -1 || separator + 2 >= rest.length) return null;
    return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
};

export const describeTool = (tool: Pick<ToolCall, 'name' | 'summary'>): ToolPresentation => {
    /**
     * The Server falls back to the tool name when an input carries no recognizable subject, so an equal summary means
     * "nothing more to show", not a subject that happens to match.
     */
    const rawSubject = tool.summary === tool.name ? undefined : tool.summary;
    const mcp = parseMcpName(tool.name);
    if (mcp)
        return {
            kind: 'mcp',
            label: mcp.server.replaceAll('_', ' '),
            subject: mcp.tool,
            isCodeSubject: true,
        };
    const known = TOOL_KINDS[tool.name.toLowerCase()];
    if (!known)
        return { kind: 'other', label: tool.name, subject: rawSubject, isCodeSubject: true };
    const subject =
        rawSubject && FILE_KINDS.has(known.kind) && /[\\/]/u.test(rawSubject)
            ? basename(rawSubject)
            : rawSubject;
    return { ...known, subject, isCodeSubject: !PROSE_KINDS.has(known.kind) };
};

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
    `${count} ${count === 1 ? singular : pluralForm}`;

const GROUP_PHRASES: Record<ToolKind, (count: number) => string> = {
    command: (count) => `ran ${plural(count, 'command')}`,
    read: (count) => `read ${plural(count, 'file')}`,
    list: (count) => `listed ${plural(count, 'folder')}`,
    edit: (count) => `edited ${plural(count, 'file')}`,
    write: (count) => `wrote ${plural(count, 'file')}`,
    search: (count) => `ran ${plural(count, 'search', 'searches')}`,
    web: (count) => `browsed ${plural(count, 'page')}`,
    agent: (count) => `ran ${plural(count, 'agent')}`,
    plan: () => 'updated the plan',
    skill: (count) => `used ${plural(count, 'skill')}`,
    mcp: (count) => `called ${plural(count, 'MCP tool')}`,
    question: (count) => `asked ${plural(count, 'question')}`,
    image: (count) => `viewed ${plural(count, 'image')}`,
    stop: (count) => `stopped ${plural(count, 'process', 'processes')}`,
    thought: () => 'thought',
    other: (count) => `used ${plural(count, 'tool')}`,
};

/**
 * Counts tools per kind in first-seen order, so the phrase leads with what the Agent did first.
 */
export const toolKindCounts = (tools: ReadonlyArray<Pick<ToolCall, 'name' | 'summary'>>) => {
    const counts = new Map<ToolKind, number>();
    for (const tool of tools) {
        const { kind } = describeTool(tool);
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return [...counts].map(([kind, count]) => ({ kind, count }));
};

export const summarizeToolGroup = (
    tools: ReadonlyArray<Pick<ToolCall, 'name' | 'summary'>>,
): string => {
    const phrase = toolKindCounts(tools)
        .map(({ kind, count }) => GROUP_PHRASES[kind](count))
        .join(', ');
    return phrase.charAt(0).toUpperCase() + phrase.slice(1);
};
