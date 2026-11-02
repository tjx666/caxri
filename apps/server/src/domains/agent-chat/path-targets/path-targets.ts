import type { AgentChatItem, AgentChatPatchOperation, AgentChatPathTarget } from '@caxri/protocol';
import { agentChatWorkTargetFile, readableShellCommand } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

import { isOpaqueAgentSessionId, parseCodexRolloutName } from '../../agents';

/**
 * Claude Code writes a background shell's output to `<temp>/tasks/<task id>.output`.
 */
const TASK_OUTPUT_FILE = /^([\da-z]+)\.output$/iu;

/**
 * Background shell titles a Chat remembers, so a long session cannot grow the map without bound. Older ones drop first.
 */
const MAX_TASK_TITLES = 500;

/**
 * The Agent Session ID a transcript file names: Claude Code's `<id>.jsonl`, Codex's `rollout-<time>-<thread id>.jsonl`,
 * or Grok Build's `<id>/updates.jsonl`.
 */
export function transcriptAgentSessionId(path: string): string | undefined {
    const name = pathBasename(path);
    if (name === 'updates.jsonl') {
        const folder = pathBasename(path.slice(0, -'/updates.jsonl'.length));
        return isOpaqueAgentSessionId(folder) ? folder : undefined;
    }
    const codex = parseCodexRolloutName(name)?.threadId;
    if (codex) return codex;
    const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : '';
    return isOpaqueAgentSessionId(id) && !id.startsWith('agent-') ? id : undefined;
}

/**
 * Names the one file a command or tool reads or searches when it is something the user knows by another name: a
 * background shell's output file by what that shell does, and an Agent conversation record by its Caxri Session's
 * title. Without this the row reads `Read bau8pcg1e.output` or `Searched x in 11111111-....jsonl`, which says nothing
 * about which task or conversation the Agent looked at. Background shells are learned from the upserts themselves
 * (Claude Code's `backgroundTaskId` on the command row), so a replayed history resolves them as a live turn does.
 */
export class ChatPathTargets {
    private readonly taskTitles = new Map<string, string>();

    constructor(
        /**
         * The title of the Caxri Session an Agent Session ID belongs to, if any.
         */
        private readonly sessionTitle: (agentSessionId: string) => string | undefined,
    ) {}

    private learn(item: AgentChatItem): void {
        if (item.type !== 'command' || item.taskId === undefined) return;
        this.taskTitles.delete(item.taskId);
        this.taskTitles.set(item.taskId, item.description ?? readableShellCommand(item.command));
        if (this.taskTitles.size > MAX_TASK_TITLES)
            this.taskTitles.delete(this.taskTitles.keys().next().value!);
    }

    private withTarget(item: AgentChatItem): AgentChatItem {
        if ((item.type !== 'command' && item.type !== 'toolCall') || item.pathTarget) return item;
        const file = agentChatWorkTargetFile(item);
        const pathTarget = file && this.target(file.path);
        return pathTarget ? { ...item, pathTarget } : item;
    }

    private target(path: string): AgentChatPathTarget | undefined {
        const name = pathBasename(path);
        const taskId = TASK_OUTPUT_FILE.exec(name)?.[1];
        const taskTitle = taskId && this.taskTitles.get(taskId);
        if (taskTitle) return { kind: 'taskOutput', title: taskTitle.slice(0, 1_000) };
        const agentSessionId = transcriptAgentSessionId(path);
        const sessionTitle = agentSessionId && this.sessionTitle(agentSessionId);
        return sessionTitle
            ? { kind: 'sessionTranscript', title: sessionTitle.slice(0, 1_000) }
            : undefined;
    }

    stamp(operations: readonly AgentChatPatchOperation[]): readonly AgentChatPatchOperation[] {
        let stamped: AgentChatPatchOperation[] | undefined;
        for (const [index, operation] of operations.entries()) {
            if (operation.op !== 'upsertItem') continue;
            this.learn(operation.item);
            const item = this.withTarget(operation.item);
            if (item === operation.item) continue;
            stamped ??= [...operations];
            stamped[index] = { op: 'upsertItem', item };
        }
        return stamped ?? operations;
    }
}
