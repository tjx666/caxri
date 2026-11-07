import type { AgentChatLabelTranslate } from './agent-chat-labels.js';
import { translateAgentChatLabel } from './agent-chat-labels.js';
import { describeShellCommand } from './agent-shell-command.js';
import { agentToolLabel, CLI_ACTIVE_LABEL_KEYS } from './tool-rows/agent-tool-labels.js';
import type { AgentShellCliLabel } from './tool-rows/shell/agent-shell-cli.js';
import { describeShellRow, describeSkillRead } from './tool-rows/shell/agent-shell-rows.js';
import {
    isAgentShellScriptLabel,
    SCRIPT_LABEL_NOUNS,
} from './tool-rows/shell/agent-shell-script.js';
import { unwrapShellCommand } from './tool-rows/shell/agent-shell-title.js';

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
    | 'commit'
    | 'computer'
    | 'edit'
    | 'image'
    | 'list'
    | 'manage'
    | 'mcp'
    | 'other'
    | 'plan'
    | 'pullRequest'
    | 'push'
    | 'question'
    | 'read'
    | 'search'
    | 'skill'
    | 'stop'
    | 'test'
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
    // Claude Code's tool that runs a script fanning out into subagents.
    workflow: { kind: 'agent', label: 'Ran workflow' },
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
 * Tools whose summary is a subagent rather than a command or a prompt. Codex's own summary for a v1 `wait` or
 * `closeAgent` is a receiver count (`1 agent`), which the label already says; the Server replaces it with the
 * subagents' names when it knows them ({@link AGENT_COUNT}).
 */
const AGENT_SUBJECT_TOOLS = new Set([
    'agentcompleted',
    'closeagent',
    'interruptagent',
    'sendmessage',
]);

/**
 * A v1 collab call's receiver count (`1 agent`, `2 agents`), which names nobody.
 */
const AGENT_COUNT = /^\d+ agents?$/u;

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
 * Claude Code's `SendMessage` row summary, `to <recipient>: <first line>` (built by the Server's `sendMessageSummary`).
 */
const AGENT_MESSAGE_SUMMARY = /^to (\S+?)(?:: (.+))?$/su;

/**
 * A recipient Claude Code names by its generated agent id (`a9fa29d284b88501c`) rather than a teammate name; the id
 * means nothing to a reader, so the row shows the subagent's title or only the message instead.
 */
const AGENT_ID_RECIPIENT = /^[\da-f]{12,}$/u;

export interface AgentMessageSummary {
    /**
     * The teammate name the message went to; absent when Claude Code addressed a generated agent id.
     */
    recipient?: string;
    message?: string;
}

/**
 * Splits a Claude Code `SendMessage` summary into who it went to and what it said, or `undefined` for any other summary
 * (a Codex multi-agent v2 `sendMessage` summary is the subagent's path, read by {@link agentDisplayName}).
 */
export const parseAgentMessageSummary = (
    summary: string | undefined,
): AgentMessageSummary | undefined => {
    const match = summary === undefined ? null : AGENT_MESSAGE_SUMMARY.exec(summary);
    if (!match) return undefined;
    const [, recipient = '', message] = match;
    return {
        ...(!AGENT_ID_RECIPIENT.test(recipient) && { recipient }),
        ...(message && { message }),
    };
};

/**
 * A message row's subject: `researcher: Check the tests`, or only the message when the recipient has no readable name.
 * `recipientName` overrides the parsed recipient, for a row whose subagent's title is known.
 */
export const agentMessageSubject = (
    { message, recipient }: AgentMessageSummary,
    recipientName: string | undefined = recipient,
): string | undefined => {
    if (recipientName && message) return `${recipientName}: ${message}`;
    return recipientName ?? message;
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
    const message = toolName === 'sendmessage' ? parseAgentMessageSummary(rawSubject) : undefined;
    if (message) {
        const subject = agentMessageSubject(message);
        return { ...known, ...(subject && { subject }), isCodeSubject: false };
    }
    if (known.kind === 'wait' || AGENT_SUBJECT_TOOLS.has(toolName)) {
        // A receiver count (`1 agent`) says nothing the label does not; only a subagent name says who it was. The
        // Server names a v1 receiver by its Background work title (`Review the diff`), which is shown as written.
        const name =
            agentDisplayName(rawSubject) ??
            (rawSubject && !AGENT_COUNT.test(rawSubject) ? rawSubject : undefined);
        if (name && known.label === 'Waited for agents')
            return { kind: 'wait', label: 'Waited for', subject: name, isCodeSubject: false };
        return { ...known, ...(name && { subject: name }), isCodeSubject: false };
    }
    // A v2 `started` activity names the subagent; a v1 `spawnAgent` call's summary is its prompt, shown as is.
    if (toolName === 'spawnagent') {
        const name = agentDisplayName(rawSubject);
        if (name) return { ...known, subject: name, isCodeSubject: false };
    }
    if (rawSubject && known.kind === 'command' && known.label === 'Ran') {
        return describeShellRow(unwrapShellCommand(rawSubject));
    }
    const isPath =
        rawSubject !== undefined && FILE_KINDS.has(known.kind) && /[\\/]/u.test(rawSubject);
    if (isPath && known.kind === 'read') {
        const skill = describeSkillRead(rawSubject);
        if (skill) return skill;
    }
    return {
        ...known,
        subject: isPath ? basename(rawSubject) : rawSubject,
        isCodeSubject: !PROSE_KINDS.has(known.kind),
        ...(isPath && { path: rawSubject }),
    };
};

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
): string => {
    if (presentation.label === 'Waited for') return t('agentChat.tool.active.waitNamed');
    if (presentation.label === 'Ran workflow') return t('agentChat.tool.active.workflow');
    if (isAgentShellScriptLabel(presentation.label))
        return t('agentChat.tool.active.script', {
            script: t(SCRIPT_LABEL_NOUNS[presentation.label]),
        });
    const cliKey =
        presentation.kind === 'command'
            ? CLI_ACTIVE_LABEL_KEYS[presentation.label as AgentShellCliLabel]
            : undefined;
    if (cliKey) return t(cliKey);
    return isAgentToolActionKind(presentation.kind)
        ? t(`agentChat.tool.active.${presentation.kind}`)
        : agentToolLabel(presentation.label, t);
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
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string => {
    const { kind } = presentation;
    const label = agentToolLabel(presentation.label, t);
    // An inline script names its language in every state (`Failed to run Python script`).
    const script = isAgentShellScriptLabel(presentation.label)
        ? t(SCRIPT_LABEL_NOUNS[presentation.label])
        : undefined;
    const verb =
        script === undefined
            ? isAgentToolActionKind(kind)
                ? t(`agentChat.tool.verb.${kind}`)
                : undefined
            : t('agentChat.tool.verb.script', { script });
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
            if (script !== undefined) return t('agentChat.tool.stopped.script', { script });
            return isAgentToolActionKind(kind)
                ? t(`agentChat.tool.stopped.${kind}`)
                : t('agentChat.tool.stoppedNamed', { label });
        }
    }
};

/**
 * How many files one read covers: a shell read of several files (`sed -n 1,80p a.ts && sed -n 1,40p b.ts`) counts each.
 */
function readFileCount(tool: Pick<ToolCall, 'summary'>): number {
    const action = tool.summary ? describeShellCommand(unwrapShellCommand(tool.summary)) : null;
    return action?.kind === 'read' ? action.paths.length : 1;
}

/**
 * Counts tools per kind in first-seen order, so the phrase leads with what the Agent did first. Reads count files.
 */
export const agentToolKindCounts = (tools: ReadonlyArray<Pick<ToolCall, 'name' | 'summary'>>) => {
    const counts = new Map<AgentToolKind, number>();
    for (const tool of tools) {
        const { kind } = describeAgentTool(tool);
        counts.set(kind, (counts.get(kind) ?? 0) + (kind === 'read' ? readFileCount(tool) : 1));
    }
    return [...counts].map(([kind, count]) => ({ kind, count }));
};

/**
 * The one subagent a group's waits name (`Reviewer`), so its phrase says whom the Agent waited for; `undefined` when
 * they name none or several. A v2 `wait_agent` names nobody, but the completion that answered it does.
 */
const waitedAgentName = (tools: ReadonlyArray<Pick<ToolCall, 'name' | 'summary'>>) => {
    const names = new Set(
        tools.flatMap((tool) => {
            const { kind, subject } = describeAgentTool(tool);
            return kind === 'wait' && subject ? [subject] : [];
        }),
    );
    return names.size === 1 ? [...names][0] : undefined;
};

/**
 * The phrases of {@link summarizeAgentToolGroup}, one per kind in the order the Agent first used it, each after the
 * first carrying its leading separator (`Ran 3 commands`, `, read 2 files`), so a surface can mark a kind joining the
 * summary while the kinds already there keep their place.
 */
export const agentToolGroupPhrases = (
    tools: ReadonlyArray<Pick<ToolCall, 'name' | 'summary'>>,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): Array<{ kind: AgentToolKind; text: string }> =>
    agentToolKindCounts(tools).map(({ kind, count }, index) => {
        const name = kind === 'wait' ? waitedAgentName(tools) : undefined;
        const phrase = name
            ? t('agentChat.tool.group.waitNamed', { name })
            : t(`agentChat.tool.group.${kind}${count === 1 ? 'One' : 'Other'}`, { count });
        return {
            kind,
            text:
                index === 0
                    ? phrase.charAt(0).toUpperCase() + phrase.slice(1)
                    : t('agentChat.tool.groupSeparator') + phrase,
        };
    });

/**
 * `Ran 3 commands, read 2 files`: one phrase per kind, in the order the Agent first used it.
 */
export const summarizeAgentToolGroup = (
    tools: ReadonlyArray<Pick<ToolCall, 'name' | 'summary'>>,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string =>
    agentToolGroupPhrases(tools, t)
        .map(({ text }) => text)
        .join('');
