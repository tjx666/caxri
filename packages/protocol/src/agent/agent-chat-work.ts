import { pathBasename } from '@caxri/utils';

import type { AgentChatItem, AgentChatTurn } from './agent-chat-contract.js';
import type { AgentToolKind, AgentToolPresentation } from './agent-tool-presentation.js';
import {
    agentToolActiveLabel,
    agentToolOutcomeLabel,
    describeAgentTool,
    formatNoticeableDuration,
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
 * `Worked for 2m 1s`, or how a turn that did not complete ended. A turn under a second reads as plain `Worked`, as a
 * work row drops its sub-second duration: `<1s` is noise.
 */
export function agentChatTurnLabel(turn: Pick<AgentChatTurn, 'durationMs' | 'status'>): string {
    const duration = formatNoticeableDuration(turn.durationMs);
    const verb =
        turn.status === 'interrupted'
            ? 'Stopped after'
            : turn.status === 'failed'
              ? 'Failed after'
              : 'Worked for';
    if (duration) return `${verb} ${duration}`;
    return turn.status === 'interrupted'
        ? 'Stopped'
        : turn.status === 'failed'
          ? 'Failed'
          : 'Worked';
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
 * The kind, verb, and subject a work row shows. Commands and file changes are first-class items rather than named
 * tools, so they are described here; every other tool goes through the shared provider tool table. A settled item that
 * did not complete names its outcome in the verb (`Failed to edit`), so the title tells the truth on its own.
 */
export function describeAgentChatWork(item: AgentChatWorkItem): AgentToolPresentation {
    const presentation = describeAgentChatWorkAction(item);
    if (item.type === 'reasoning' || item.status === 'running') return presentation;
    return { ...presentation, label: agentToolOutcomeLabel(presentation, item.status) };
}

/**
 * The work row's presentation before its outcome is applied, with English labels. Desktop translates this at display
 * time, so it is exported alongside the English `describeAgentChatWork` the phone reads.
 */
export function describeAgentChatWorkAction(item: AgentChatWorkItem): AgentToolPresentation {
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
            const more = item.changes.length > 1 ? ` +${item.changes.length - 1} more` : '';
            return {
                kind: isCreate ? 'write' : 'edit',
                label: isCreate ? 'Created' : 'Edited',
                ...(first && { subject: `${pathBasename(first.path)}${more}` }),
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
    presentation: Pick<AgentToolPresentation, 'kind' | 'label'> = describeAgentChatWork(item),
): string {
    return isAgentChatWorkRunning(item) ? agentToolActiveLabel(presentation) : presentation.label;
}

/**
 * The duration a work row shows: only once it is noticeable. A row of `<1s` labels says nothing a reader can act on.
 */
export function agentChatWorkDuration(item: AgentChatWorkItem): string | null {
    return item.type === 'command' || item.type === 'toolCall'
        ? formatNoticeableDuration(item.durationMs)
        : null;
}

/**
 * How a run of work renders: settled work collapses into one summary row once it holds at least two tool calls
 * (reasoning alone never earns a summary, which would hide the thought's title), and work still running stays out of
 * the summary as its own live rows, so the step in progress is always readable. `isLive` marks more work as running,
 * such as a tool call that returned while the background task it started keeps going.
 */
export function splitAgentChatWork(
    items: readonly AgentChatWorkItem[],
    isLive: (item: AgentChatWorkItem) => boolean = () => false,
): {
    summarized: readonly AgentChatWorkItem[];
    rows: readonly AgentChatWorkItem[];
} {
    const isRunning = (item: AgentChatWorkItem): boolean =>
        isAgentChatWorkRunning(item) || isLive(item);
    const settled = items.filter((item) => !isRunning(item));
    const live = items.filter((item) => isRunning(item));
    const toolCount = settled.filter((item) => item.type !== 'reasoning').length;
    return toolCount >= 2
        ? { summarized: settled, rows: live }
        : { summarized: [], rows: [...settled, ...live] };
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
export function summarizeAgentChatWork(items: readonly AgentChatWorkItem[]): string {
    const tools = agentChatWorkSummaryTools(items);
    if (tools.length === 0)
        return items.some((item) => item.type === 'reasoning' && item.streaming)
            ? 'Thinking'
            : 'Thought';
    const failed = items.filter((item) => isAgentChatWorkUnsuccessful(item)).length;
    const summary = summarizeAgentToolGroup(tools);
    return failed > 0 ? `${summary}, ${failed} failed` : summary;
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
