import type { AgentChatLabelTranslate } from '../agent-chat-labels.js';
import { translateAgentChatLabel } from '../agent-chat-labels.js';
import type { AgentChatWorkItem } from '../agent-chat-work.js';
import {
    agentChatActiveWork,
    agentChatCurrentWork,
    describeAgentChatWork,
    isAgentChatWorkRunning,
    isAgentChatWorkUnsuccessful,
} from '../agent-chat-work.js';
import type { AgentToolKind } from '../agent-tool-presentation.js';
import {
    agentToolActiveLabel,
    agentToolGroupPhrases,
    agentToolKindCounts,
    describeAgentTool,
} from '../agent-tool-presentation.js';

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
        // Failures of earlier items ride in the title, not on a failure glyph: a red badge beside a title that names the
        // running step reads as "this step failed". The count keeps a failed command from hiding in an open group.
        const failed = items.filter((item) => isAgentChatWorkUnsuccessful(item)).length;
        if (failed === 0) return [{ key: 'active', text }];
        const failures = t('agentChat.workGroup.withFailures', { summary: '', count: failed });
        return [
            { key: 'active', text },
            { key: 'failures', text: failures },
        ];
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
 * Whether the summary phrases name a current step (`Running bun run x`) rather than the settled aggregate. While they
 * do, the group's failures are already in the title as a count, so a Client must not also mark the row with a failure
 * glyph: it would sit beside the running step and read as that step failing.
 */
export function isAgentChatWorkSummaryNamingStep(
    phrases: ReadonlyArray<{ key: string; text: string }>,
): boolean {
    return phrases[0]?.key === 'active';
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
