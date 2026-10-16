import { pathBasename } from '@caxri/utils';

import type { AgentChatItem, AgentChatItemStatus, AgentChatTurn } from './agent-chat-contract.js';
import type { AgentChatLabelTranslate } from './agent-chat-labels.js';
import { translateAgentChatLabel } from './agent-chat-labels.js';
import type { AgentToolKind, AgentToolPresentation } from './agent-tool-presentation.js';
import {
    agentToolActiveLabel,
    agentToolLabel,
    agentToolOutcomeLabel,
    describeAgentTool,
    formatNoticeableDuration,
    formatShortDuration,
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

/**
 * The finished turn's outcome and elapsed time, using the same visibility rules as its work rows.
 */
export function agentChatTurnLabel(
    turn: Pick<AgentChatTurn, 'durationMs' | 'status' | 'interruptionReason'>,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    const duration = formatAgentChatFinishedDuration(turn.durationMs, turn.status, t);
    if (duration)
        return t(
            turn.status === 'interrupted'
                ? turn.interruptionReason === 'user'
                    ? 'agentChat.fold.stoppedByYouAfter'
                    : 'agentChat.fold.stoppedAfter'
                : turn.status === 'failed'
                  ? 'agentChat.fold.failedAfter'
                  : 'agentChat.fold.workedFor',
            { duration },
        );
    return t(
        turn.status === 'interrupted'
            ? turn.interruptionReason === 'user'
                ? 'agentChat.fold.stoppedByYou'
                : 'agentChat.fold.stopped'
            : turn.status === 'failed'
              ? 'agentChat.fold.failed'
              : 'agentChat.fold.worked',
    );
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
 * The one kind a group shares, or `undefined` when it mixes kinds and shows a generic glyph.
 */
export function agentChatWorkKind(items: readonly AgentChatWorkItem[]): AgentToolKind | undefined {
    const kinds = new Set(
        items
            .filter((item) => item.type !== 'reasoning')
            .map((item) => describeAgentChatWork(item).kind),
    );
    if (kinds.size === 0) return 'thought';
    return kinds.size === 1 ? [...kinds][0] : undefined;
}
