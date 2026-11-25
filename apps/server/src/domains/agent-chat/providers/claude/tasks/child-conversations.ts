import { clip, isRecord, stringField } from '../../../chat-items';
import type { AgentChatSessionHost } from '../../../chat-provider';
import type { ChatTaskList } from '../../../tasks/task-list';
import { claudeAssistantItems } from '../items';
import { ClaudeStream } from '../stream';
import { settleClaudeToolItem } from '../tool-results';
import type { ClaudeTaskFeedback } from './feedback';

type Json = Record<string, unknown>;

/**
 * Routes the frames of each subagent's own conversation into the task projection of the run they belong to. Subagent
 * frames carry the spawning tool call's id as `parent_tool_use_id`; streaming state is kept per subagent so a subagent
 * never corrupts the parent's stream. Inputs are untrusted JSON.
 */
export class ClaudeChildConversations {
    /**
     * Streaming state per subagent, keyed by the parent tool call.
     */
    private readonly streams = new Map<string, ClaudeStream>();

    /**
     * A subagent frame's `parent_tool_use_id` to the listed task it belongs to, when they differ (a resumed subagent).
     */
    private readonly routes = new Map<string, string>();

    constructor(
        private readonly options: {
            host: AgentChatSessionHost;
            list: ChatTaskList;
            feedback: ClaudeTaskFeedback;
            /**
             * Whether the user declined this tool call; Claude Code reports a declined tool as an error result.
             */
            takeDeclined: (toolUseId: string) => boolean;
            /**
             * The listed task id of a Claude Code `task_id`, once the task is listed.
             */
            listedId: (claudeId: string) => string | undefined;
            /**
             * Inspects a subagent's assistant frame for the subagents it spawns in turn.
             */
            onAssistant: (body: Json, taskId: string) => void;
            /**
             * Ends a subagent whose blocking tool call returned inside this conversation.
             */
            settleAgentResult: (toolUseId: string, block: Json) => void;
        },
    ) {}

    private stream(taskId: string): ClaudeStream {
        let stream = this.streams.get(taskId);
        if (!stream) {
            stream = new ClaudeStream((operations) =>
                this.options.host.applyTask(taskId, operations),
            );
            this.streams.set(taskId, stream);
        }
        return stream;
    }

    /**
     * The listed task a subagent frame belongs to. A resumed subagent (`SendMessage` to a finished or orphaned one) is
     * listed under the resuming call, but its frames still name the original `Agent` call as `parent_tool_use_id`;
     * keying by that alone left a phantom task running forever. Assistant and user frames carry the subagent's
     * `agent_id` (its unchanging `task_id`), which names the run actually listed; `stream_event` frames carry none, so
     * they follow the route an earlier frame of the same parent established.
     */
    private taskId(message: Json, parent: string): string {
        const agentId = stringField(message.agent_id);
        const listed = agentId === undefined ? undefined : this.options.listedId(agentId);
        if (listed) {
            if (listed === parent) this.routes.delete(parent);
            else this.routes.set(parent, listed);
            return listed;
        }
        return this.routes.get(parent) ?? parent;
    }

    /**
     * Records the model a subagent's response actually came from. The spawning call names a model only when the parent
     * overrides it, and then only as an alias (`haiku`); without one the subagent inherits a model the call never
     * states, so its own responses are the only source for the resolved id. `<synthetic>` marks a CLI-made message, not
     * a model.
     */
    private noteModel(taskId: string, body: Json): void {
        const model = stringField(body.model);
        if (!model || model === '<synthetic>') return;
        const clipped = clip(model, 200);
        const { list } = this.options;
        if (list.get(taskId)?.model !== clipped) list.upsert(taskId, { model: clipped });
    }

    private onAssistantFrame(taskId: string, message: Json): void {
        const { feedback, host } = this.options;
        if (feedback.onTaskMessage(taskId, message)) return;
        const body = isRecord(message.message) ? message.message : undefined;
        if (!body) return;
        this.noteModel(taskId, body);
        const stream = this.stream(taskId);
        const { items } = claudeAssistantItems(body, undefined, stream.ids);
        if (items.length > 0) {
            feedback.note(taskId, items);
            host.applyTask(
                taskId,
                items.map((item) => ({ op: 'upsertItem', item })),
            );
        }
        stream.settle(items);
        // A subagent may spawn its own subagents.
        this.options.onAssistant(body, taskId);
    }

    private onUserFrame(taskId: string, message: Json): void {
        const { host } = this.options;
        const body = isRecord(message.message) ? message.message : undefined;
        const content = Array.isArray(body?.content) ? body.content : [];
        this.options.feedback.observeToolResults(content);
        const items = new Map((host.readTask(taskId)?.items ?? []).map((item) => [item.id, item]));
        for (const block of content) {
            if (!isRecord(block) || block.type !== 'tool_result') continue;
            const toolUseId = stringField(block.tool_use_id);
            if (!toolUseId) continue;
            const id = clip(toolUseId, 200);
            const item = items.get(id);
            const settled =
                item &&
                settleClaudeToolItem(item, block, {
                    structured: message.tool_use_result,
                    wasDeclined: this.options.takeDeclined(id),
                });
            if (settled) host.applyTask(taskId, [{ op: 'upsertItem', item: settled }]);
            this.options.settleAgentResult(id, block);
        }
    }

    /**
     * Routes one frame of a subagent's own conversation into the task projection of the run it belongs to.
     */
    onMessage(message: Json): void {
        const parent = stringField(message.parent_tool_use_id);
        if (!parent) return;
        const taskId = this.taskId(message, clip(parent, 200));
        const { list } = this.options;
        if (!list.get(taskId)) {
            // A partial frame names no `agent_id`, so it cannot tell a resumed run from a new one; its full frame follows.
            if (message.type === 'stream_event') return;
            const row = this.options.host.read().items.find((item) => item.id === taskId);
            list.upsert(taskId, {
                kind: 'agent',
                // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- an empty summary names nothing
                title: (row?.type === 'toolCall' && row.summary) || 'Agent',
                itemId: taskId,
            });
        }
        switch (message.type) {
            case 'stream_event': {
                this.stream(taskId).onEvent(message.event);
                return;
            }
            case 'assistant': {
                this.onAssistantFrame(taskId, message);
                return;
            }
            case 'user': {
                this.onUserFrame(taskId, message);
                return;
            }
            default: {
                // Tool progress and other subagent frames are not conversation content.
            }
        }
    }

    /**
     * Drops the streaming state of a subagent that ended.
     */
    forget(taskId: string): void {
        this.streams.delete(taskId);
    }
}
