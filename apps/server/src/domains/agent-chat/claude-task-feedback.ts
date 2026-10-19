import type { AgentChatItem } from '@caxri/protocol';

import { clip, isRecord, stringField } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';
import { claudeFeedbackItems, claudeFeedbackToolUseId } from './claude-feedback';

type Json = Record<string, unknown>;
type FeedbackItem = Extract<AgentChatItem, { type: 'notice' }>;

/**
 * Hook events Claude Code names `<Event>:<Tool>` (`PreToolUse:Read`). Only these belong to a single tool call.
 */
const TOOL_HOOK_NAME =
    /^(?:PreToolUse|PostToolUse|PostToolUseFailure|PermissionRequest|PermissionDenied):(.+)$/u;

/**
 * A Post* Hook can report after its tool's result already arrived, so a settled call stays attributable this long.
 */
const SETTLED_TOOL_GRACE_MS = 10_000;

/**
 * Where a feedback frame belongs: a subagent task, the main Agent, or nowhere identifiable (a session lifecycle Hook).
 */
export type ClaudeFeedbackOwner = 'main' | { taskId: string } | undefined;

interface ToolCall {
    name: string;
    /**
     * The subagent task that called the tool; absent for the main Agent.
     */
    taskId?: string;
    settledAt?: number;
}

/**
 * Keeps tool-scoped Claude feedback with the conversation that emitted the tool. Claude Code's live `hook_response`
 * frames carry no tool id (verified with Claude Code 2.1.302: a subagent's blocked `PreToolUse:Read` arrives with only
 * `hook_name`), so a tool Hook is matched by name to the call still in flight, preferring the newest. Session lifecycle
 * Hooks (`SessionStart`, `Stop`, `UserPromptSubmit`) name no tool and stay session feedback instead of being guessed
 * into a task.
 */
export class ClaudeTaskFeedback {
    private readonly owners = new Map<string, string>();
    /**
     * Every tool call seen, oldest first, keyed by tool use id.
     */
    private readonly calls = new Map<string, ToolCall>();

    constructor(
        private readonly host: AgentChatSessionHost,
        private readonly now: () => number = Date.now,
    ) {}

    private apply(taskId: string, items: FeedbackItem[]): void {
        this.host.applyTask(
            taskId,
            items.map((item) => ({ op: 'upsertItem', item })),
        );
    }

    private prune(): void {
        const cutoff = this.now() - SETTLED_TOOL_GRACE_MS;
        for (const [id, call] of this.calls)
            if (call.settledAt !== undefined && call.settledAt < cutoff) this.calls.delete(id);
    }

    note(taskId: string, items: readonly AgentChatItem[]): void {
        for (const item of items)
            if (['command', 'fileChange', 'toolCall'].includes(item.type))
                this.owners.set(item.id, taskId);
    }

    /**
     * Records the tool calls in one assistant message, from the main Agent or from a subagent task.
     */
    observeToolUses(content: unknown, taskId?: string): void {
        if (!Array.isArray(content)) return;
        for (const block of content) {
            if (!isRecord(block) || block.type !== 'tool_use') continue;
            const id = stringField(block.id);
            const name = stringField(block.name);
            if (!id || !name) continue;
            this.calls.set(clip(id, 200), { name, ...(taskId && { taskId }) });
        }
        this.prune();
    }

    observeToolResults(content: unknown): void {
        if (!Array.isArray(content)) return;
        for (const block of content) {
            if (!isRecord(block) || block.type !== 'tool_result') continue;
            const id = stringField(block.tool_use_id);
            const call = id && this.calls.get(clip(id, 200));
            if (call) call.settledAt = this.now();
        }
    }

    /**
     * The owner of a tool Hook frame, matched by the tool it names: the newest call still running, else the newest one
     * that settled within {@link SETTLED_TOOL_GRACE_MS}.
     */
    toolHookOwner(message: Json): ClaudeFeedbackOwner {
        if (message.subtype !== 'hook_response') return undefined;
        const toolName = TOOL_HOOK_NAME.exec(stringField(message.hook_name) ?? '')?.[1];
        if (!toolName) return undefined;
        this.prune();
        let settled: ToolCall | undefined;
        let running: ToolCall | undefined;
        for (const call of this.calls.values()) {
            if (call.name !== toolName) continue;
            if (call.settledAt === undefined) running = call;
            else settled = call;
        }
        const call = running ?? settled;
        if (!call) return undefined;
        return call.taskId ? { taskId: call.taskId } : 'main';
    }

    /**
     * Applies a feedback frame to the subagent task it belongs to. Returns false when it belongs to the main Agent or
     * to the session, leaving it for the main timeline.
     */
    onMessage(message: Json): boolean {
        const toolUseId = claudeFeedbackToolUseId(message);
        const owner = toolUseId ? this.owners.get(toolUseId) : undefined;
        const taskId = owner ?? (toolUseId ? undefined : taskOf(this.toolHookOwner(message)));
        if (!taskId) return false;
        const items = claudeFeedbackItems(message, undefined, 'agent');
        if (items.length > 0) this.apply(taskId, items);
        return items.length > 0;
    }

    onTaskMessage(taskId: string, message: Json): boolean {
        const items = claudeFeedbackItems(message, undefined, 'agent');
        if (items.length > 0) this.apply(taskId, items);
        return items.length > 0;
    }

    clear(): void {
        this.owners.clear();
        this.calls.clear();
    }
}

function taskOf(owner: ClaudeFeedbackOwner): string | undefined {
    return typeof owner === 'object' ? owner.taskId : undefined;
}
