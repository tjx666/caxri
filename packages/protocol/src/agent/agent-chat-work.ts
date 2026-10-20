import { pathBasename } from '@caxri/utils';

import type { AgentChatItem, AgentChatItemStatus, AgentChatTurn } from './agent-chat-contract.js';
import type { AgentChatLabelTranslate } from './agent-chat-labels.js';
import { translateAgentChatLabel } from './agent-chat-labels.js';
import { agentChatMcpToolTitle } from './agent-chat-mcp.js';
import type { AgentToolKind, AgentToolPresentation } from './agent-tool-presentation.js';
import {
    agentToolActiveLabel,
    agentToolKindCounts,
    agentToolLabel,
    agentToolOutcomeLabel,
    describeAgentTool,
    formatNoticeableDuration,
    formatShortDuration,
    parseAgentMcpToolName,
    summarizeAgentToolGroup,
} from './agent-tool-presentation.js';

/**
 * What the Agent did between replies: reasoning, commands, file changes, and other tool calls. Every Agent Chat client
 * renders these as work rows and summaries with the presentation rules in this module.
 */
export type AgentChatWorkItem = Extract<
    AgentChatItem,
    { type: 'command' | 'fileChange' | 'reasoning' | 'toolCall' }
>;

const WORK_ITEM_TYPES: ReadonlySet<AgentChatItem['type']> = new Set<AgentChatWorkItem['type']>([
    'command',
    'fileChange',
    'reasoning',
    'toolCall',
]);

/**
 * Whether an item is a piece of work (a thought, command, tool call, or change) rather than a message or notice.
 */
export function isAgentChatWorkItem(item: AgentChatItem): item is AgentChatWorkItem {
    return WORK_ITEM_TYPES.has(item.type);
}

/**
 * Successful work stays quiet below three seconds; unsuccessful work retains every known duration. Running clocks keep
 * their independent one-second threshold.
 */
export function formatAgentChatFinishedDuration(
    durationMs: number | undefined,
    status: AgentChatItemStatus,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string | null {
    if (status === 'running') return formatNoticeableDuration(durationMs, t);
    if (status === 'completed' && (durationMs === undefined || durationMs < 3_000)) return null;
    return formatShortDuration(durationMs, t);
}

const TURN_OUTCOME_LABELS = {
    worked: ['agentChat.fold.worked', 'agentChat.fold.workedFor'],
    failed: ['agentChat.fold.failed', 'agentChat.fold.failedAfter'],
    stopped: ['agentChat.fold.stopped', 'agentChat.fold.stoppedAfter'],
    stoppedByYou: ['agentChat.fold.stoppedByYou', 'agentChat.fold.stoppedByYouAfter'],
    stoppedByAgent: ['agentChat.fold.stoppedByAgent', 'agentChat.fold.stoppedByAgentAfter'],
} as const;

/**
 * The finished turn's outcome and elapsed time, using the same visibility rules as its work rows.
 */
export function agentChatTurnLabel(
    turn: Pick<AgentChatTurn, 'durationMs' | 'status' | 'stoppedBy'>,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    const duration = formatAgentChatFinishedDuration(turn.durationMs, turn.status, t);
    const [label, labelWithDuration] = TURN_OUTCOME_LABELS[turnOutcome(turn)];
    return duration ? t(labelWithDuration, { duration }) : t(label);
}

/**
 * The label family for how a turn ended. A stop names who asked for it, so a turn the user stopped on purpose does not
 * read like one that broke off.
 */
function turnOutcome(
    turn: Pick<AgentChatTurn, 'status' | 'stoppedBy'>,
): keyof typeof TURN_OUTCOME_LABELS {
    if (turn.status === 'failed') return 'failed';
    if (turn.status !== 'interrupted') return 'worked';
    if (turn.stoppedBy === 'user') return 'stoppedByYou';
    return turn.stoppedBy === 'agent' ? 'stoppedByAgent' : 'stopped';
}

const REASONING_TITLE = /^\*\*([^*\n]+)\*\*[ \t]*$/gmu;

/**
 * Codex opens each reasoning summary part with a bold title line (`**Planning the fix**`). The row shows the latest
 * title, which is what the Agent is thinking about now, as the Codex app does. A summary with a single leading title
 * drops it from the expanded text so it is not read twice; several titles stay as the text's own section headings.
 */
export function agentChatReasoningTitle(text: string): { title?: string; body: string } {
    const titles = Array.from(text.matchAll(REASONING_TITLE));
    const last = titles.at(-1);
    if (!last?.[1]) return { body: text };
    const title = last[1].trim();
    return titles.length === 1 && last.index === 0
        ? { title, body: text.slice(last[0].length).trimStart() }
        : { title, body: text };
}

/**
 * The kind, verb, and subject a work row shows, in the reader's language. Commands and file changes are first-class
 * items rather than named tools, so they are described here; every other tool goes through the shared provider tool
 * table. A settled item that did not complete names its outcome in the verb (`Failed to edit`), so the title tells the
 * truth on its own.
 */
export function describeAgentChatWork(
    item: AgentChatWorkItem,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): AgentToolPresentation {
    const action = describeAgentChatWorkAction(item, t);
    const presentation = { ...action, label: agentToolLabel(action.label, t) };
    if (item.type === 'reasoning' || item.status === 'running') return presentation;
    return { ...presentation, label: agentToolOutcomeLabel(presentation, item.status, t) };
}

/**
 * The work row's presentation before its outcome is applied, with the English label the tool table names it by.
 */
function describeAgentChatWorkAction(
    item: AgentChatWorkItem,
    t: AgentChatLabelTranslate,
): AgentToolPresentation {
    switch (item.type) {
        case 'reasoning': {
            const { title } = agentChatReasoningTitle(item.text);
            return {
                kind: 'thought',
                label: item.streaming ? 'Thinking' : 'Thought',
                ...(title && { subject: title }),
                isCodeSubject: false,
            };
        }
        case 'command': {
            const presentation = describeAgentTool({ name: 'shell', summary: item.command });
            // The Agent's own words for the command read better than the command line, which the row still shows
            // expanded. A read, search, or listing already names what it looked at, so it keeps that.
            return item.description && presentation.kind === 'command'
                ? { ...presentation, subject: item.description, isCodeSubject: false }
                : presentation;
        }
        case 'toolCall': {
            return describeAgentTool(item);
        }
        case 'fileChange': {
            const first = item.changes.at(0);
            const isCreate = item.changes.every((change) => change.kind === 'add');
            const name = first && pathBasename(first.path);
            return {
                kind: isCreate ? 'write' : 'edit',
                label: isCreate ? 'Created' : 'Edited',
                ...(name !== undefined && {
                    subject:
                        item.changes.length > 1
                            ? t('agentChat.tool.moreFiles', {
                                  name,
                                  count: item.changes.length - 1,
                              })
                            : name,
                }),
                isCodeSubject: true,
                ...(first && item.changes.length === 1 && { path: first.path }),
            };
        }
    }
}

export const isAgentChatWorkRunning = (item: AgentChatWorkItem): boolean =>
    item.type === 'reasoning' ? item.streaming : item.status === 'running';

/**
 * A stable group still describes its current action, preferring the newest running tool over reasoning. A command reads
 * as the Agent's description of it when there is one, as its settled row does.
 */
export function agentChatActiveWork(
    items: readonly AgentChatWorkItem[],
): { item: AgentChatWorkItem; presentation: AgentToolPresentation } | undefined {
    let item: AgentChatWorkItem | undefined;
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const candidate = items[index];
        if (!isAgentChatWorkRunning(candidate)) continue;
        if (candidate.type !== 'reasoning') {
            item = candidate;
            break;
        }
        item ??= candidate;
    }
    if (!item) return undefined;
    return { item, presentation: describeAgentChatWork(item) };
}

/**
 * The kind of work the active turn is doing right now and when that piece of work began, for a status indicator that
 * shows what kind of tool runs. It scans back from the newest item and stops at an earlier turn's item, so a long
 * history costs only the active turn's tail.
 */
export function agentChatTurnActiveWork(
    items: readonly AgentChatItem[],
    turnId: string,
): { kind: AgentToolKind; startedAt: number | undefined } | undefined {
    let start = items.length;
    while (start > 0) {
        const previous = items[start - 1].turnId;
        if (previous !== undefined && previous !== turnId) break;
        start -= 1;
    }
    const active = agentChatActiveWork(items.slice(start).filter(isAgentChatWorkItem));
    return active && { kind: active.presentation.kind, startedAt: active.item.createdAt };
}

/**
 * The verb a work row leads with: present tense while the item runs (`Running`, `Editing`), else the settled verb
 * `describeAgentChatWork` chose (`Ran`, `Failed to edit`).
 */
export function agentChatWorkVerb(
    item: AgentChatWorkItem,
    presentation?: Pick<AgentToolPresentation, 'kind' | 'label'>,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    const described = presentation ?? describeAgentChatWork(item, t);
    return isAgentChatWorkRunning(item) ? agentToolActiveLabel(described, t) : described.label;
}

/**
 * The duration a work row shows, using the same outcome rules as a finished turn.
 */
export function agentChatWorkDuration(
    item: AgentChatWorkItem,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string | null {
    return item.type === 'command' || item.type === 'toolCall'
        ? formatAgentChatFinishedDuration(item.durationMs, item.status, t)
        : null;
}

/**
 * Tool names whose row starts a subagent, compared without case or separators: Claude Code's `Task` and `Agent`, and
 * Codex's collab `spawnAgent` (also seen as `spawn_agent`).
 */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['task', 'agent', 'spawnagent']);

function normalizedToolName(name: string): string {
    return name.toLowerCase().replaceAll(/[^a-z]/gu, '');
}

/**
 * Whether a timeline row started a subagent. Such a row stays openable even when the live task list no longer knows it
 * (a resumed conversation), because `agentChat.readTask` rebuilds a subagent from the item that started it.
 */
export function isAgentChatSubagentItem(item: AgentChatItem): boolean {
    return item.type === 'toolCall' && SUBAGENT_TOOL_NAMES.has(normalizedToolName(item.name));
}

/**
 * Ordinary tools enter their summary from the first frame, so completion never moves a temporary standalone row.
 * Reasoning alone stays readable. Independently running tasks marked by `isIndependent` retain their own rows and
 * controls.
 */
export function splitAgentChatWork(
    items: readonly AgentChatWorkItem[],
    isIndependent: (item: AgentChatWorkItem) => boolean = () => false,
): {
    summarized: readonly AgentChatWorkItem[];
    rows: readonly AgentChatWorkItem[];
} {
    const isSeparate = (item: AgentChatWorkItem): boolean =>
        isAgentChatSubagentItem(item) ||
        (item.type === 'command' && item.background === true) ||
        isIndependent(item);
    const summarized = items.filter((item) => !isSeparate(item));
    return summarized.some((item) => item.type !== 'reasoning')
        ? { summarized, rows: items.filter((item) => isSeparate(item)) }
        : { summarized: [], rows: items };
}

/**
 * Work items that did not do what they set out to: failed, or declined by the user or a policy.
 */
export const isAgentChatWorkUnsuccessful = (item: AgentChatWorkItem): boolean =>
    item.type !== 'reasoning' && (item.status === 'failed' || item.status === 'declined');

/**
 * The status glyph a summary row shows: `failed` when any item failed, else `declined` when any was declined, else
 * none.
 */
export function agentChatWorkGroupFailure(
    items: readonly AgentChatWorkItem[],
): 'declined' | 'failed' | undefined {
    const unsuccessful = items.filter((item) => isAgentChatWorkUnsuccessful(item));
    if (unsuccessful.some((item) => item.type !== 'reasoning' && item.status === 'failed'))
        return 'failed';
    return unsuccessful.length > 0 ? 'declined' : undefined;
}

/**
 * `Ran 3 commands, read 2 files` for a group, counting each changed file as one edit. Reasoning only names the group
 * when it is all the group holds. Items that failed or were declined are counted at the end (`, 1 failed`), so a
 * collapsed group never reads as a clean run.
 */
export function summarizeAgentChatWork(
    items: readonly AgentChatWorkItem[],
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    const active = agentChatActiveWork(items);
    if (active) {
        const verb = agentToolActiveLabel(active.presentation, t);
        return [verb, active.presentation.subject].filter(Boolean).join(' ');
    }
    const tools = agentChatWorkSummaryTools(items);
    if (tools.length === 0)
        return t(
            items.some((item) => item.type === 'reasoning' && item.streaming)
                ? 'agentChat.tool.label.thinking'
                : 'agentChat.tool.label.thought',
        );
    const failed = items.filter((item) => isAgentChatWorkUnsuccessful(item)).length;
    const summary = summarizeAgentToolGroup(tools, t);
    return failed > 0 ? t('agentChat.workGroup.withFailures', { summary, count: failed }) : summary;
}

/**
 * The tool calls a work summary counts: one per command or tool call and one per changed file; reasoning counts none.
 */
export function agentChatWorkSummaryTools(
    items: readonly AgentChatWorkItem[],
): Array<{ name: string; summary?: string }> {
    return items.flatMap((item): Array<{ name: string; summary?: string }> => {
        switch (item.type) {
            case 'reasoning': {
                return [];
            }
            case 'command': {
                return [{ name: 'shell', summary: item.command }];
            }
            case 'fileChange': {
                const name = item.changes.every((change) => change.kind === 'add')
                    ? 'write'
                    : 'edit';
                return item.changes.map((change) => ({ name, summary: change.path }));
            }
            case 'toolCall': {
                return [item];
            }
            default: {
                return [];
            }
        }
    });
}

/**
 * A work row's kind, verb, and subject on a Client that shows the MCP server's own icon: the shared
 * `describeAgentChatWork`, except that an MCP tool call reads as its tool (`Web search exa`), the way the Codex app
 * names it beside the server's icon; the icon, not an `exa` prefix, says which server answered. A Client without the
 * icon (the CLI, or a phone whose server has none) keeps `describeAgentChatWork`, whose label names the server.
 */
export function describeAgentChatWorkRow(
    item: AgentChatWorkItem,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): AgentToolPresentation {
    const mcp = item.type === 'toolCall' ? parseAgentMcpToolName(item.name) : null;
    if (!mcp || item.type !== 'toolCall') return describeAgentChatWork(item, t);
    const action: AgentToolPresentation = {
        kind: 'mcp',
        label: agentChatMcpToolTitle(mcp.tool),
        isCodeSubject: false,
    };
    if (item.status === 'running') return action;
    return { ...action, label: agentToolOutcomeLabel(action, item.status, t) };
}

/**
 * The glyph a work summary row leads with, the way the Codex app marks a group by its first part: the kind its phrase
 * names first (`Called 3 MCP tools, ran 2 commands` leads with MCP), plus the first MCP tool call's name when MCP
 * leads, so the row shows that server's icon.
 */
export function agentChatWorkSummaryGlyph(items: readonly AgentChatWorkItem[]): {
    kind: AgentToolKind;
    mcpToolName?: string;
} {
    const active = agentChatActiveWork(items);
    if (active)
        return {
            kind: active.presentation.kind,
            ...(active.presentation.kind === 'mcp' &&
                active.item.type === 'toolCall' && { mcpToolName: active.item.name }),
        };
    const tools = agentChatWorkSummaryTools(items);
    const kind = agentToolKindCounts(tools).at(0)?.kind ?? 'thought';
    const mcpToolName =
        kind === 'mcp'
            ? tools.find((tool) => describeAgentTool(tool).kind === 'mcp')?.name
            : undefined;
    return { kind, ...(mcpToolName && { mcpToolName }) };
}

/**
 * The one kind a group shares, or `undefined` when it mixes kinds and shows a generic glyph.
 */
export function agentChatWorkKind(items: readonly AgentChatWorkItem[]): AgentToolKind | undefined {
    const active = agentChatActiveWork(items);
    if (active) return active.presentation.kind;
    const kinds = new Set(
        items
            .filter((item) => item.type !== 'reasoning')
            .map((item) => describeAgentChatWork(item).kind),
    );
    if (kinds.size === 0) return 'thought';
    return kinds.size === 1 ? [...kinds][0] : undefined;
}
