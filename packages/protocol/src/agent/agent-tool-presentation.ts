import type { AgentChatLabelKey, AgentChatLabelTranslate } from './agent-chat-labels.js';
import { translateAgentChatLabel } from './agent-chat-labels.js';
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
    | 'browser'
    | 'command'
    | 'computer'
    | 'edit'
    | 'image'
    | 'list'
    | 'manage'
    | 'mcp'
    | 'other'
    | 'plan'
    | 'question'
    | 'read'
    | 'search'
    | 'skill'
    | 'stop'
    | 'thought'
    | 'wait'
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
    /**
     * Codex's other collab tools (`sendInput`, `closeAgent`) and the multi-agent v2 `subAgentActivity` kinds the Server
     * names `sendMessage`, `interruptAgent`, and `agentCompleted`. A v2 activity's summary is the subagent's path
     * (`pr_watch_waiter`), which reads as its name; see {@link agentDisplayName}.
     */
    sendinput: { kind: 'manage', label: 'Messaged agent' },
    sendmessage: { kind: 'manage', label: 'Messaged agent' },
    closeagent: { kind: 'manage', label: 'Closed agent' },
    interruptagent: { kind: 'manage', label: 'Stopped agent' },
    /**
     * Codex's collab `wait` (multi-agent v2 calls it `wait_agent`) blocks until any subagent reports, and names none,
     * so the row says what it waits for instead of the bare tool name. A subagent's completion is the wait's answer,
     * which is why it shares the kind: a settled group reads `Waited for agents`, not `Ran 1 agent`.
     */
    wait: { kind: 'wait', label: 'Waited for agents' },
    wait_agent: { kind: 'wait', label: 'Waited for agents' },
    agentcompleted: { kind: 'wait', label: 'Agent finished' },
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
const PROSE_KINDS = new Set<AgentToolKind>([
    'agent',
    'manage',
    'question',
    'thought',
    'wait',
    'web',
]);

/**
 * Tools whose summary is a subagent rather than a command or a prompt. `wait` is absent on purpose: Codex's only
 * summary for it is a receiver count (`1 agent`), which `Waited for agents` already says.
 */
const AGENT_SUBJECT_TOOLS = new Set([
    'agentcompleted',
    'closeagent',
    'interruptagent',
    'sendmessage',
]);

const basename = (path: string): string => {
    const trimmed = path.replace(/[\\/]+$/u, '');
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return index === -1 ? trimmed : trimmed.slice(index + 1) || trimmed;
};

/**
 * A multi-agent v2 subagent name (`pr_watch_waiter`, or its full path `/root/pr_watch_waiter`) as the name the Codex
 * app shows (`Pr watch waiter`). Anything else (a v1 receiver count such as `1 agent`, or a spawn prompt) is not a name
 * and yields `undefined`.
 */
const agentDisplayName = (subject: string | undefined): string | undefined => {
    if (!subject) return undefined;
    const segment = subject.startsWith('/') ? basename(subject) : subject;
    if (!/^[\w-]+$/u.test(segment)) return undefined;
    const name = segment.replaceAll(/[_-]+/gu, ' ').trim();
    return name ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : undefined;
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

/**
 * Plumbing an Agent appends only to keep its own output short (`2>&1`, `2>/dev/null`, a trailing `| head -30`) says
 * nothing about what the command does, yet fills a one-line title. The title drops it at each command boundary; the
 * expanded row keeps the exact command line.
 */
const SHELL_TITLE_NOISE =
    /\s*(?:\d?>&\d|&?\d?>\s*\/dev\/null|\|\s*(?:head|tail)(?:\s+-n)?(?:\s+-?\d+)?)(?=\s*(?:;|&&|\|\||$))/gu;

export const readableShellCommand = (command: string): string => {
    let readable = command;
    // Stripping `| tail -1` leaves the `2>&1` before it at the end of its command, so repeat until nothing changes.
    for (let previous = ''; previous !== readable;) {
        previous = readable;
        readable = readable.replaceAll(SHELL_TITLE_NOISE, '');
    }
    return readable.trim() || command;
};

/**
 * Computer Use steps (`browserUse` and `computerUse`, named by the Server after the surface a Codex step drove) read as
 * the step's own title, the way the Codex app lists them; the generic label stands in only when the step had none.
 */
const COMPUTER_USE_TOOLS: Partial<Record<string, { kind: AgentToolKind; label: string }>> = {
    browseruse: { kind: 'browser', label: 'Used the browser' },
    computeruse: { kind: 'computer', label: 'Used Computer Use' },
};

export const describeAgentTool = (
    tool: Pick<ToolCall, 'name' | 'summary'>,
): AgentToolPresentation => {
    /**
     * The Server falls back to the tool name when an input carries no recognizable subject, so an equal summary means
     * "nothing more to show", not a subject that happens to match.
     */
    const rawSubject = tool.summary === tool.name ? undefined : tool.summary;
    const computerUse = COMPUTER_USE_TOOLS[tool.name.toLowerCase()];
    if (computerUse)
        return {
            kind: computerUse.kind,
            label: rawSubject ?? computerUse.label,
            isCodeSubject: false,
        };
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
    const toolName = tool.name.toLowerCase();
    if (known.kind === 'wait' || AGENT_SUBJECT_TOOLS.has(toolName)) {
        // A receiver count (`1 agent`) says nothing the label does not; only a subagent name says who it was.
        const name = agentDisplayName(rawSubject);
        return { ...known, ...(name && { subject: name }), isCodeSubject: false };
    }
    // A v2 `started` activity names the subagent; a v1 `spawnAgent` call's summary is its prompt, shown as is.
    if (toolName === 'spawnagent') {
        const name = agentDisplayName(rawSubject);
        if (name) return { ...known, subject: name, isCodeSubject: false };
    }
    if (rawSubject && known.kind === 'command' && known.label === 'Ran') {
        const command = unwrapShellCommand(rawSubject);
        return (
            describeShellAction(command) ?? {
                ...known,
                subject: readableShellCommand(command),
                isCodeSubject: true,
            }
        );
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
 * The catalog key of each English label in the tool table above, so a surface can show the label in the reader's
 * language while the presentation itself (stored in snapshots and sent to every client) stays English source data. A
 * label outside this table (an MCP server, an unknown tool's own name, or a Computer Use step's title) is an identifier
 * and stays as is.
 */
const TOOL_LABEL_KEYS: Readonly<Record<string, AgentChatLabelKey>> = {
    'Ran': 'agentChat.tool.label.ran',
    'Checked output': 'agentChat.tool.label.checkedOutput',
    'Sent input': 'agentChat.tool.label.sentInput',
    'Stopped': 'agentChat.tool.label.stopped',
    'Read': 'agentChat.tool.label.read',
    'Listed': 'agentChat.tool.label.listed',
    'Listed files': 'agentChat.tool.label.listedFiles',
    'Edited': 'agentChat.tool.label.edited',
    'Created': 'agentChat.tool.label.created',
    'Patched': 'agentChat.tool.label.patched',
    'Wrote': 'agentChat.tool.label.wrote',
    'Searched': 'agentChat.tool.label.searched',
    'Found files': 'agentChat.tool.label.foundFiles',
    'Looked up tools': 'agentChat.tool.label.lookedUpTools',
    'Fetched': 'agentChat.tool.label.fetched',
    'Searched the web': 'agentChat.tool.label.searchedWeb',
    'Ran agent': 'agentChat.tool.label.ranAgent',
    'Started agent': 'agentChat.tool.label.startedAgent',
    'Messaged agent': 'agentChat.tool.label.messagedAgent',
    'Closed agent': 'agentChat.tool.label.closedAgent',
    'Stopped agent': 'agentChat.tool.label.stoppedAgent',
    'Waited for agents': 'agentChat.tool.label.waitedForAgents',
    'Agent finished': 'agentChat.tool.label.agentFinished',
    'Updated plan': 'agentChat.tool.label.updatedPlan',
    'Proposed plan': 'agentChat.tool.label.proposedPlan',
    'Used skill': 'agentChat.tool.label.usedSkill',
    'Asked': 'agentChat.tool.label.asked',
    'Viewed image': 'agentChat.tool.label.viewedImage',
    'Thought': 'agentChat.tool.label.thought',
    'Thinking': 'agentChat.tool.label.thinking',
    'Used the browser': 'agentChat.tool.label.usedBrowser',
    'Used Computer Use': 'agentChat.tool.label.usedComputerUse',
};

/**
 * A tool presentation's past-tense label (`Edited`) in the reader's language. A label the table does not know, or one
 * already translated, is returned unchanged, so applying this twice is harmless.
 */
export function agentToolLabel(
    label: string,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    const key = Object.hasOwn(TOOL_LABEL_KEYS, label) ? TOOL_LABEL_KEYS[label] : undefined;
    return key ? t(key) : label;
}

/**
 * Tool kinds that name an action. `mcp` and `other` name a server or tool instead and keep their label, and a Computer
 * Use step's label is the title the Agent wrote for it.
 */
export type AgentToolActionKind = Exclude<AgentToolKind, 'browser' | 'computer' | 'mcp' | 'other'>;

export const isAgentToolActionKind = (kind: AgentToolKind): kind is AgentToolActionKind =>
    kind !== 'browser' && kind !== 'computer' && kind !== 'mcp' && kind !== 'other';

/**
 * The present-tense verb for work still in progress (`Running git status`). MCP and unknown tools keep their label,
 * which names the server or tool rather than an action.
 */
export const agentToolActiveLabel = (
    presentation: Pick<AgentToolPresentation, 'kind' | 'label'>,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string =>
    isAgentToolActionKind(presentation.kind)
        ? t(`agentChat.tool.active.${presentation.kind}`)
        : agentToolLabel(presentation.label, t);

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
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string => {
    const { kind } = presentation;
    const label = agentToolLabel(presentation.label, t);
    const verb = isAgentToolActionKind(kind) ? t(`agentChat.tool.verb.${kind}`) : undefined;
    switch (outcome) {
        case 'completed': {
            return label;
        }
        case 'failed': {
            return verb
                ? t('agentChat.tool.failedTo', { verb })
                : t('agentChat.tool.failedNamed', { label });
        }
        case 'declined': {
            return verb
                ? t('agentChat.tool.notAllowedTo', { verb })
                : t('agentChat.tool.notAllowedNamed', { label });
        }
        case 'interrupted': {
            return isAgentToolActionKind(kind)
                ? t(`agentChat.tool.stopped.${kind}`)
                : t('agentChat.tool.stoppedNamed', { label });
        }
    }
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

/**
 * `Ran 3 commands, read 2 files`: one phrase per kind, in the order the Agent first used it.
 */
export const summarizeAgentToolGroup = (
    tools: ReadonlyArray<Pick<ToolCall, 'name' | 'summary'>>,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string => {
    const phrase = agentToolKindCounts(tools)
        .map(({ kind, count }) =>
            t(`agentChat.tool.group.${kind}${count === 1 ? 'One' : 'Other'}`, { count }),
        )
        .join(t('agentChat.tool.groupSeparator'));
    return phrase.charAt(0).toUpperCase() + phrase.slice(1);
};

/**
 * A short elapsed time for a finished Agent turn or tool call: `<1s`, `45s`, `2m`, `2m 1s` (`2 分钟 1 秒` in Chinese, as
 * the Codex app writes it). Rounds to whole seconds because the reader compares turns, not milliseconds. Returns `null`
 * when no duration was recorded.
 */
export function formatShortDuration(
    durationMs: number | undefined,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string | null {
    if (durationMs === undefined) return null;
    const total = Math.round(durationMs / 1000);
    if (total < 1) return t('agentChat.fold.durationUnderOneSecond');
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes === 0) return t('agentChat.fold.durationSeconds', { seconds });
    if (seconds === 0) return t('agentChat.fold.durationMinutes', { minutes });
    return t('agentChat.fold.durationMinutesSeconds', { minutes, seconds });
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
export function formatNoticeableDuration(
    durationMs: number | undefined,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string | null {
    if (durationMs === undefined || durationMs < NOTICEABLE_DURATION_MS) return null;
    return formatShortDuration(durationMs, t);
}
