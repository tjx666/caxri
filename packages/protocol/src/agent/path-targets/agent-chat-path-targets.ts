import { z } from 'zod';

import type { AgentChatItem } from '../agent-chat-contract.js';
import type { AgentChatLabelTranslate } from '../agent-chat-labels.js';
import { translateAgentChatLabel } from '../agent-chat-labels.js';
import { describeShellCommand } from '../agent-shell-command.js';
import type { AgentToolPresentation } from '../agent-tool-presentation.js';
import { describeAgentTool } from '../agent-tool-presentation.js';
import { unwrapShellCommand } from '../tool-rows/agent-shell-title.js';

/**
 * What the one file a command or tool reads or searches is, when Server Core recognized it, so the row names it instead
 * of an opaque file name: `taskOutput` is a background shell's output file (`tasks/bau8pcg1e.output`) titled by what
 * that shell does, and `sessionTranscript` is an Agent conversation record (`<conversation id>.jsonl`) titled by its
 * Caxri Session. Stamped when the item enters the projection, so a renamed Session keeps the title it had then.
 */
export const agentChatPathTargetSchema = z.strictObject({
    kind: z.enum(['taskOutput', 'sessionTranscript']),
    title: z.string().min(1).max(1_000),
});

export type AgentChatPathTarget = z.infer<typeof agentChatPathTargetSchema>;

/**
 * The one file a command or tool call reads or searches, with the pattern when it searches it, as the Agent wrote the
 * path (possibly relative). Server Core recognizes this file to stamp the item's `pathTarget`. Absent for anything
 * else, including a read of several files.
 */
export function agentChatWorkTargetFile(
    item: AgentChatItem,
): { path: string; pattern?: string } | undefined {
    if (item.type === 'command') {
        const action = describeShellCommand(unwrapShellCommand(item.command));
        if (action?.kind === 'read' && action.paths.length === 1) {
            const [path] = action.paths;
            return path ? { path } : undefined;
        }
        if (action?.kind === 'search' && action.path !== undefined)
            return { path: action.path, pattern: action.pattern };
        return undefined;
    }
    if (item.type !== 'toolCall') return undefined;
    const { kind, path } = describeAgentTool(item);
    return kind === 'read' && path !== undefined ? { path } : undefined;
}

/**
 * Names a recognized file by its title instead of its file name: reading a background shell's output reads `Checked
 * output <what the shell does>`, as Claude Code's own `BashOutput` row does, and a search reads `<pattern> in <title>`.
 * The kind stays, so the group summary still counts the read. The label stays the English tool-table label that
 * `agentToolLabel` translates at render time; the search subject is built here, so `t` supplies its wording.
 */
export function withAgentChatPathTarget(
    presentation: AgentToolPresentation,
    item: Extract<AgentChatItem, { type: 'command' | 'toolCall' }>,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): AgentToolPresentation {
    const target = item.pathTarget;
    if (!target) return presentation;
    if (presentation.kind === 'search') {
        const pattern = agentChatWorkTargetFile(item)?.pattern;
        return pattern === undefined
            ? presentation
            : {
                  ...presentation,
                  subject: t('agentChat.tool.searchIn', { pattern, title: target.title }),
                  isCodeSubject: false,
              };
    }
    if (presentation.kind !== 'read') return presentation;
    return {
        ...presentation,
        ...(target.kind === 'taskOutput' && { label: 'Checked output' }),
        subject: target.title,
        isCodeSubject: false,
    };
}
