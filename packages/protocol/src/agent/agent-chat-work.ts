import { pathBasename } from '@caxri/utils';

import type {
    AgentChatItem,
    AgentChatItemStatus,
    AgentChatSnapshot,
    AgentChatTask,
    AgentChatTurn,
} from './agent-chat-contract.js';
import type { AgentChatLabelTranslate } from './agent-chat-labels.js';
import {
    formatNoticeableDuration,
    formatShortDuration,
    translateAgentChatLabel,
} from './agent-chat-labels.js';
import { agentChatMcpToolTitle } from './agent-chat-mcp.js';
import type { AgentToolKind, AgentToolPresentation } from './agent-tool-presentation.js';
import {
    agentToolActiveLabel,
    agentToolGroupPhrases,
    agentToolKindCounts,
    agentToolLabel,
    agentToolOutcomeLabel,
    describeAgentTool,
    parseAgentMcpToolName,
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
function formatAgentChatFinishedDuration(
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
    stoppedByUsageGuard: [
        'agentChat.fold.stoppedByUsageGuard',
        'agentChat.fold.stoppedByUsageGuardAfter',
    ],
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
    if (turn.stoppedBy === 'usageGuard') return 'stoppedByUsageGuard';
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
 * Back-to-back reasoning items read as one thought. Codex emits a reasoning item per burst of thinking, often several
 * in a row whose summaries are only bold titles, and a row each stacked identical `Thought` rows down the transcript. A
 * run becomes one item keyed by its first item, so the row keeps its expansion as later items join; its text joins the
 * parts, so the row shows the latest title and the expanded view lists every title in order (Paseo likewise appends a
 * thought to the one before it). A lone reasoning item and every other item are returned as they are.
 */
export function mergeAgentChatReasoning(
    items: readonly AgentChatWorkItem[],
): readonly AgentChatWorkItem[] {
    const merged: AgentChatWorkItem[] = [];
    for (const item of items) {
        const previous = merged.at(-1);
        if (item.type !== 'reasoning' || previous?.type !== 'reasoning') {
            merged.push(item);
            continue;
        }
        const text = [previous.text.trim(), item.text.trim()].filter(Boolean).join('\n\n');
        merged[merged.length - 1] = {
            ...previous,
            text,
            streaming: previous.streaming || item.streaming,
        };
    }
    return merged.length === items.length ? items : merged;
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

/**
 * Tool names whose row starts a subagent, compared without case or separators: Claude Code's `Task` and `Agent`, and
 * Codex's collab `spawnAgent` (also seen as `spawn_agent`).
 */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['task', 'agent', 'spawnagent']);

function normalizedToolName(name: string): string {
    return name.toLowerCase().replaceAll(/[^a-z]/gu, '');
}

/**
 * The subagent tools whose settled verb is `Ran agent`: Claude Code's `Task` and `Agent`.
 */
const RAN_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['task', 'agent']);

export const isAgentChatWorkRunning = (item: AgentChatWorkItem): boolean =>
    item.type === 'reasoning' ? item.streaming : item.status === 'running';

/**
 * Whether a work row reads as running: the item itself runs, or the subagent it started still works. Claude Code's
 * `Task`/`Agent` call returns as soon as a background subagent launches, so its settled `Ran agent` would contradict
 * the running task beside it. Codex's `spawnAgent` reads `Started agent`, already true once it returns, and a
 * background shell keeps its own settled facts (`Background`, `Exit N`), so neither follows its task.
 */
export const isAgentChatWorkRowRunning = (
    item: AgentChatWorkItem,
    linkedTask?: Pick<AgentChatTask, 'kind' | 'status'>,
): boolean =>
    isAgentChatWorkRunning(item) ||
    (linkedTask?.kind === 'agent' &&
        linkedTask.status === 'running' &&
        item.type === 'toolCall' &&
        RAN_AGENT_TOOL_NAMES.has(normalizedToolName(item.name)));

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
 * Whether the main Agent is blocked on its subagents right now: the active turn's newest running work is a wait
 * (Codex's collab `wait`, multi-agent v2's `wait_agent`), the row that reads `Waiting for agents`. A subagent's own
 * items live in its task projection, so only the main conversation's wait counts.
 */
export function isAgentChatWaitingOnAgents(
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'items'> | undefined,
): boolean {
    if (!snapshot?.activeTurnId) return false;
    return agentChatTurnActiveWork(snapshot.items, snapshot.activeTurnId)?.kind === 'wait';
}

/**
 * The verb a work row and its detail title lead with: present tense while the row runs (`Running`, `Editing`, `Running
 * agent` while the subagent `linkedTask` names still works; see `isAgentChatWorkRowRunning`), else the settled verb
 * `describeAgentChatWork` chose (`Ran`, `Failed to edit`).
 */
export function agentChatWorkVerb(
    item: AgentChatWorkItem,
    presentation?: Pick<AgentToolPresentation, 'kind' | 'label'>,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
    linkedTask?: Pick<AgentChatTask, 'kind' | 'status'>,
): string {
    const described = presentation ?? describeAgentChatWork(item, t);
    return isAgentChatWorkRowRunning(item, linkedTask)
        ? agentToolActiveLabel(described, t)
        : described.label;
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
const isAgentChatWorkUnsuccessful = (item: AgentChatWorkItem): boolean =>
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
 * What a group still being worked on is doing now: the running item, or between calls the newest one, so the title
 * keeps naming the current step (`Running pnpm lint`) until the run ends instead of falling back to a count. Reasoning
 * names it only when the group holds nothing else.
 */
function agentChatCurrentWork(
    items: readonly AgentChatWorkItem[],
): { item: AgentChatWorkItem; presentation: AgentToolPresentation } | undefined {
    const active = agentChatActiveWork(items);
    if (active) return active;
    let item = items.at(-1);
    for (let index = items.length - 1; index >= 0; index -= 1) {
        if (items[index].type !== 'reasoning') {
            item = items[index];
            break;
        }
    }
    return item && { item, presentation: describeAgentChatWork(item) };
}

/**
 * The items a work summary row describes. While its running item is not yet shown (`shouldShowRunning` is false), the
 * row keeps describing the work that already settled, so a call that finishes within moments never flips a settled
 * `Edited 5 files` to `Running pnpm lint` and back. A group with nothing settled yet describes its running work at
 * once.
 */
export function agentChatWorkSummaryItems(
    items: readonly AgentChatWorkItem[],
    shouldShowRunning: boolean,
): readonly AgentChatWorkItem[] {
    if (shouldShowRunning) return items;
    const settled = items.filter((item) => !isAgentChatWorkRunning(item));
    return settled.length > 0 ? settled : items;
}

/**
 * `Ran 3 commands, read 2 files` for a group, counting each changed file as one edit. Reasoning only names the group
 * when it is all the group holds. Items that failed or were declined are counted at the end (`, 1 failed`), so a
 * collapsed group never reads as a clean run.
 */
export function summarizeAgentChatWork(
    items: readonly AgentChatWorkItem[],
    t: AgentChatLabelTranslate = translateAgentChatLabel,
    options: { isOpen?: boolean } = {},
): string {
    return agentChatWorkSummaryPhrases(items, t, options)
        .map(({ text }) => text)
        .join('');
}

/**
 * The tool calls of a group running at the same time: an Agent can start several before any ends (three reads at once),
 * and a title naming only one of them would read as if the Agent did one thing.
 */
function agentChatParallelWork(items: readonly AgentChatWorkItem[]): AgentChatWorkItem[] {
    return items.filter((item) => item.type !== 'reasoning' && isAgentChatWorkRunning(item));
}

/**
 * {@link summarizeAgentChatWork} as keyed phrases that join into it: the running action, the thinking label, or one
 * phrase per tool kind (`Edited 1 file`, `, ran 3 commands`) followed by the failure count (`, 1 failed`). A key stays
 * the same while its phrase only updates a count, so the Renderer can animate a phrase that joins the summary. An open
 * group (`isOpen`, the running turn's latest work) names its current step even between calls, as the Codex app does,
 * and becomes the aggregate only once the run ends.
 */
export function agentChatWorkSummaryPhrases(
    items: readonly AgentChatWorkItem[],
    t: AgentChatLabelTranslate = translateAgentChatLabel,
    { isOpen = false }: { isOpen?: boolean } = {},
): Array<{ key: string; text: string }> {
    const active = isOpen ? agentChatCurrentWork(items) : agentChatActiveWork(items);
    if (active && (active.item.type !== 'reasoning' || isAgentChatWorkRunning(active.item))) {
        const verb = agentToolActiveLabel(active.presentation, t);
        const label = [verb, active.presentation.subject].filter(Boolean).join(' ');
        const others = agentChatParallelWork(items).filter((item) => item !== active.item).length;
        const text =
            others > 0 ? t('agentChat.workGroup.andMore', { label, count: others }) : label;
        return [{ key: 'active', text }];
    }
    const tools = agentChatWorkSummaryTools(items);
    if (tools.length === 0) {
        const isThinking = items.some((item) => item.type === 'reasoning' && item.streaming);
        const label = isThinking ? 'agentChat.tool.label.thinking' : 'agentChat.tool.label.thought';
        return [{ key: 'reasoning', text: t(label) }];
    }
    const phrases = agentToolGroupPhrases(tools, t).map(({ kind, text }) => ({ key: kind, text }));
    const failed = items.filter((item) => isAgentChatWorkUnsuccessful(item)).length;
    if (failed === 0) return phrases;
    // The failure template wraps the whole summary; an empty summary leaves exactly the text it appends.
    const failures = t('agentChat.workGroup.withFailures', { summary: '', count: failed });
    return [...phrases, { key: 'failures', text: failures }];
}

/**
 * The tool calls a work summary counts: one per command or tool call and one per changed file; reasoning counts none.
 */
function agentChatWorkSummaryTools(
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
 * The glyph a work summary row leads with: the running call's kind while one runs, otherwise the kind every call shares
 * (plus the first MCP tool call's name, so the row shows that server's icon). A settled summary mixing kinds (`Searched
 * once, ran 1 command`) takes the generic work glyph, since no single kind's icon describes it.
 */
export function agentChatWorkSummaryGlyph(
    items: readonly AgentChatWorkItem[],
    { isOpen = false }: { isOpen?: boolean } = {},
): {
    kind: AgentToolKind;
    mcpToolName?: string;
} {
    const active = isOpen ? agentChatCurrentWork(items) : agentChatActiveWork(items);
    const parallelKinds = new Set(
        agentChatParallelWork(items).map((item) => describeAgentChatWork(item).kind),
    );
    if (parallelKinds.size > 1) return { kind: 'other' };
    if (active)
        return {
            kind: active.presentation.kind,
            ...(active.presentation.kind === 'mcp' &&
                active.item.type === 'toolCall' && { mcpToolName: active.item.name }),
        };
    const tools = agentChatWorkSummaryTools(items);
    const counts = agentToolKindCounts(tools);
    if (counts.length > 1) return { kind: 'other' };
    const kind = counts.at(0)?.kind ?? 'thought';
    const mcpToolName =
        kind === 'mcp'
            ? tools.find((tool) => describeAgentTool(tool).kind === 'mcp')?.name
            : undefined;
    return { kind, ...(mcpToolName && { mcpToolName }) };
}
