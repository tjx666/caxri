import { describeShellCommand } from './agent-shell-command.js';

/**
 * The two fields every surface knows about a tool call: Agent Chat `toolCall` items and the mobile timeline both carry
 * them.
 */
interface ToolCall {
    name: string;
    summary?: string;
}

export type AgentToolKind =
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

export interface AgentToolPresentation {
    kind: AgentToolKind;
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
    /**
     * The one file the subject names, as the tool reported it, so a surface can open it. Absent for anything else,
     * including a read of several files.
     */
    path?: string;
}

/**
 * Provider tool names from Claude Code and Codex transcripts. Lookup is case-insensitive because Codex names are
 * snake_case while Claude Code names are PascalCase, and a few overlap in meaning.
 */
const TOOL_KINDS: Partial<Record<string, { kind: AgentToolKind; label: string }>> = {
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
    // Codex's collab tool that starts a subagent thread.
    spawnagent: { kind: 'agent', label: 'Started agent' },
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

const FILE_KINDS = new Set<AgentToolKind>(['edit', 'list', 'read', 'write']);
const PROSE_KINDS = new Set<AgentToolKind>(['agent', 'question', 'thought', 'web']);

const basename = (path: string): string => {
    const trimmed = path.replace(/[\\/]+$/u, '');
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return index === -1 ? trimmed : trimmed.slice(index + 1) || trimmed;
};

/**
 * MCP tools arrive as `mcp__<server>__<tool>` from Claude Code and as `<server>/<tool>` from Codex; the server name
 * reads better than the raw identifier.
 */
export const parseAgentMcpToolName = (name: string): { server: string; tool: string } | null => {
    if (!name.startsWith('mcp__')) {
        const slash = name.indexOf('/');
        if (slash <= 0 || slash === name.length - 1) return null;
        return { server: name.slice(0, slash), tool: name.slice(slash + 1) };
    }
    const rest = name.slice('mcp__'.length);
    const separator = rest.indexOf('__', 1);
    if (separator === -1 || separator + 2 >= rest.length) return null;
    return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
};

/**
 * Codex reports every command as the login-shell invocation that ran it (`/bin/zsh -lc "git status"`). The wrapper is
 * the same on every row, so only the inner command is worth reading. Anything that is not exactly one quoted script
 * passed to `sh`, `bash`, or `zsh` is returned unchanged.
 */
export const unwrapShellCommand = (command: string): string => {
    const match = /^(?:\S*\/)?(?:ba|z)?sh -l?c (["'])([\s\S]*)\1$/u.exec(command.trim());
    if (!match) return command;
    const [, quote, script = ''] = match;
    return quote === '"'
        ? script.replaceAll(String.raw`\"`, '"').replaceAll(String.raw`\\`, '\\')
        : script;
};

export const describeAgentTool = (
    tool: Pick<ToolCall, 'name' | 'summary'>,
): AgentToolPresentation => {
    /**
     * The Server falls back to the tool name when an input carries no recognizable subject, so an equal summary means
     * "nothing more to show", not a subject that happens to match.
     */
    const rawSubject = tool.summary === tool.name ? undefined : tool.summary;
    const mcp = parseAgentMcpToolName(tool.name);
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
    if (rawSubject && known.kind === 'command' && known.label === 'Ran') {
        const command = unwrapShellCommand(rawSubject);
        return describeShellAction(command) ?? { ...known, subject: command, isCodeSubject: true };
    }
    const isPath =
        rawSubject !== undefined && FILE_KINDS.has(known.kind) && /[\\/]/u.test(rawSubject);
    return {
        ...known,
        subject: isPath ? basename(rawSubject) : rawSubject,
        isCodeSubject: !PROSE_KINDS.has(known.kind),
        ...(isPath && { path: rawSubject }),
    };
};

/**
 * A shell command that reads, searches, or lists files reads as that action (`Read app.ts`), the way the Codex app
 * shows exploration; see `describeShellCommand`.
 */
function describeShellAction(command: string): AgentToolPresentation | null {
    const action = describeShellCommand(command);
    switch (action?.kind) {
        case 'read': {
            const [only] = action.paths;
            return {
                kind: 'read',
                label: 'Read',
                subject: action.paths.map((path) => basename(path)).join(', '),
                isCodeSubject: true,
                ...(action.paths.length === 1 && only && { path: only }),
            };
        }
        case 'search': {
            return {
                kind: 'search',
                label: 'Searched',
                subject: action.path
                    ? `${action.pattern} in ${basename(action.path)}`
                    : action.pattern,
                isCodeSubject: true,
            };
        }
        case 'list': {
            const path = action.path === '.' ? undefined : action.path;
            return path
                ? { kind: 'list', label: 'Listed', subject: basename(path), isCodeSubject: true }
                : { kind: 'list', label: 'Listed files', isCodeSubject: true };
        }
        case undefined: {
            return null;
        }
    }
}

/**
 * Present-tense verbs for work still in progress (`Running git status`), per kind. MCP and unknown tools keep their
 * label, which names the server or tool rather than an action.
 */
const ACTIVE_LABELS: Partial<Record<AgentToolKind, string>> = {
    agent: 'Running agent',
    command: 'Running',
    edit: 'Editing',
    image: 'Viewing image',
    list: 'Listing',
    plan: 'Updating plan',
    question: 'Asking',
    read: 'Reading',
    search: 'Searching',
    skill: 'Using skill',
    stop: 'Stopping',
    thought: 'Thinking',
    web: 'Browsing',
    write: 'Writing',
};

export const agentToolActiveLabel = (presentation: Pick<AgentToolPresentation, 'kind' | 'label'>) =>
    ACTIVE_LABELS[presentation.kind] ?? presentation.label;

/**
 * Base-form verbs for a tool that did not complete (`Failed to edit`), per kind. MCP and unknown tools have none: their
 * label names the server or tool rather than an action.
 */
const BASE_VERBS: Partial<Record<AgentToolKind, string>> = {
    agent: 'run agent',
    command: 'run',
    edit: 'edit',
    image: 'view image',
    list: 'list',
    plan: 'update plan',
    question: 'ask',
    read: 'read',
    search: 'search',
    skill: 'use skill',
    stop: 'stop',
    thought: 'think',
    web: 'browse',
    write: 'write',
};

/**
 * How a settled tool call ended, as far as its row title is concerned.
 */
export type AgentToolOutcome = 'completed' | 'declined' | 'failed' | 'interrupted';

/**
 * The verb a settled work row shows. A completed call keeps its past tense (`Edited`); one that did not complete says
 * so in words (`Failed to edit`, `Not allowed to run`, `Stopped editing`), so the title never reads as a success that
 * only a small status glyph contradicts. A tool without a verb keeps its label behind the outcome (`Failed: github`).
 */
export const agentToolOutcomeLabel = (
    presentation: Pick<AgentToolPresentation, 'kind' | 'label'>,
    outcome: AgentToolOutcome,
): string => {
    const verb = BASE_VERBS[presentation.kind];
    switch (outcome) {
        case 'completed': {
            return presentation.label;
        }
        case 'failed': {
            return verb ? `Failed to ${verb}` : `Failed: ${presentation.label}`;
        }
        case 'declined': {
            return verb ? `Not allowed to ${verb}` : `Not allowed: ${presentation.label}`;
        }
        case 'interrupted': {
            const active = ACTIVE_LABELS[presentation.kind];
            return active
                ? `Stopped ${active.charAt(0).toLowerCase()}${active.slice(1)}`
                : `Stopped: ${presentation.label}`;
        }
    }
};

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
    `${count} ${count === 1 ? singular : pluralForm}`;

const GROUP_PHRASES: Record<AgentToolKind, (count: number) => string> = {
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
export const agentToolKindCounts = (tools: ReadonlyArray<Pick<ToolCall, 'name' | 'summary'>>) => {
    const counts = new Map<AgentToolKind, number>();
    for (const tool of tools) {
        const { kind } = describeAgentTool(tool);
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return [...counts].map(([kind, count]) => ({ kind, count }));
};

export const summarizeAgentToolGroup = (
    tools: ReadonlyArray<Pick<ToolCall, 'name' | 'summary'>>,
): string => {
    const phrase = agentToolKindCounts(tools)
        .map(({ kind, count }) => GROUP_PHRASES[kind](count))
        .join(', ');
    return phrase.charAt(0).toUpperCase() + phrase.slice(1);
};

/**
 * A short elapsed time for a finished Agent turn or tool call: `<1s`, `45s`, `2m`, `2m 1s`. Rounds to whole seconds
 * because the reader compares turns, not milliseconds. Returns `null` when no duration was recorded.
 */
export function formatShortDuration(durationMs: number | undefined): string | null {
    if (durationMs === undefined) return null;
    const seconds = Math.round(durationMs / 1000);
    if (seconds < 1) return '<1s';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

/**
 * Below this an elapsed time is not worth showing: it would read `<1s` and then jump straight to `1s`.
 */
const NOTICEABLE_DURATION_MS = 1000;

/**
 * `formatShortDuration` once the time is noticeable, else `null`. Every Agent Chat surface that shows how long a turn,
 * a work row, a running turn, or a background task took drops sub-second times through this, so a row of `<1s` labels
 * never says something a reader cannot act on.
 */
export function formatNoticeableDuration(durationMs: number | undefined): string | null {
    if (durationMs === undefined || durationMs < NOTICEABLE_DURATION_MS) return null;
    return formatShortDuration(durationMs);
}
