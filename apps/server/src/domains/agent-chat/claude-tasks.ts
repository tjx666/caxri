import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentChatTask } from '@caxri/protocol';
import { CaxriError, MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

import { clip, closeDanglingItem, isRecord, stringField } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';
import { ChatTaskList } from './chat-tasks';
import { claudeAssistantItems, text } from './claude-items';
import { ClaudeShellOutput } from './claude-shell-output';
import { ClaudeStream } from './claude-stream';
import { ClaudeTaskFeedback } from './claude-task-feedback';
import { claudeTaskStatus, claudeTaskUsage } from './claude-task-fields';
import { settleClaudeToolItem } from './claude-tool-results';

/**
 * Background work a Claude Code Chat lists: subagents (`Agent`, formerly `Task`), workflows (`Workflow`, a
 * `local_workflow` task), and background shells (`Bash run_in_background`). Claude Code reports them as `system/task_*`
 * frames keyed by its own `task_id`, plus a `background_tasks_changed` level signal; subagent conversation frames carry
 * the spawning tool call's id as `parent_tool_use_id`. Caxri keys a subagent by that tool call id (the timeline row's
 * id, so the row opens the tab), and a background shell by Claude Code's `task_id` with `itemId` naming its Bash row. A
 * workflow is listed as a background `agent` task named by its script's `workflow_name`. Inputs are untrusted JSON.
 *
 * @see https://code.claude.com/docs/en/agent-sdk/typescript
 */

type Json = Record<string, unknown>;

/**
 * Tool names that spawn a subagent. Claude Code renamed `Task` to `Agent`; transcripts and older CLIs keep `Task`.
 */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/**
 * A Claude Code task this session has heard of. `id` is set once the task is listed in the snapshot; a foreground shell
 * stays unlisted until it moves to the background.
 */
interface KnownTask {
    id?: string;
    kind: AgentChatTask['kind'];
    toolUseId?: string;
    description: string;
    /**
     * A workflow keeps its name as its title; a `task_updated` description does not rename it.
     */
    isWorkflow?: boolean;
}

export class ClaudeTasks {
    private readonly list: ChatTaskList;

    /**
     * Streaming state per subagent, keyed by the parent tool call, so a subagent never corrupts the parent's stream.
     */
    private readonly streams = new Map<string, ClaudeStream>();

    private readonly feedback: ClaudeTaskFeedback;

    /**
     * Claude Code `task_id` to what this session knows about it.
     */
    private readonly known = new Map<string, KnownTask>();

    /**
     * Listed task id to Claude Code's `task_id`, which `stop_task` and `get_task_output` take.
     */
    private readonly claudeIds = new Map<string, string>();

    /**
     * Claude Code task ids seen in a `background_tasks_changed` payload; only those can end by leaving the level.
     */
    private readonly inLevel = new Set<string>();

    /**
     * A subagent frame's `parent_tool_use_id` to the listed task it belongs to, when they differ (a resumed subagent).
     */
    private readonly childRoutes = new Map<string, string>();

    private readonly shellOutput: ClaudeShellOutput;

    constructor(
        private readonly options: {
            host: AgentChatSessionHost;
            query: () => Query | undefined;
            /**
             * Whether the user declined this tool call; Claude Code reports a declined tool as an error result.
             */
            takeDeclined: (toolUseId: string) => boolean;
            isInterruptRequested: () => boolean;
            /**
             * Called after a task frame was handled, so turn state can react to background work draining.
             */
            onTasksChanged: () => void;
        },
    ) {
        this.list = new ChatTaskList(options.host);
        this.feedback = new ClaudeTaskFeedback(options.host);
        this.shellOutput = new ClaudeShellOutput({
            host: options.host,
            query: options.query,
            claudeId: (id) => this.claudeIds.get(id),
        });
    }

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
     * Lists a subagent from the tool call that spawns it, and seeds its tab with the prompt it was given.
     */
    private noteToolUse(block: Json): void {
        const toolUseId = stringField(block.id);
        if (!toolUseId || !AGENT_TOOLS.has(text(block.name))) return;
        const id = clip(toolUseId, 200);
        const input = isRecord(block.input) ? block.input : {};
        const agentType = stringField(input.subagent_type);
        const model = stringField(input.model);
        const existing = this.list.get(id);
        this.list.upsert(id, {
            kind: 'agent',
            title: stringField(input.description) ?? existing?.title ?? agentType ?? 'Agent',
            itemId: id,
            ...(agentType && { agentType }),
            ...(model && { model }),
            ...(!existing && { isBackground: input.run_in_background === true }),
        });
        const prompt = stringField(input.prompt);
        if (prompt && !this.options.host.readTask(id))
            this.options.host.applyTask(id, [
                {
                    op: 'upsertItem',
                    item: {
                        id: clip(`${id}:prompt`, 200),
                        type: 'userMessage',
                        text: clip(prompt, MAX_AGENT_CHAT_TEXT_LENGTH),
                    },
                },
            ]);
    }

    /**
     * Ends a subagent whose blocking tool call returned. A background subagent's tool call returns at once with a
     * placeholder, so it keeps running until its own `task_notification`.
     */
    private settleAgentResult(toolUseId: string, block: Json): void {
        const task = this.list.get(toolUseId);
        if (task?.kind !== 'agent' || task.isBackground || task.status !== 'running') return;
        const isError = block.is_error === true;
        this.finish(
            task.id,
            isError ? (this.options.isInterruptRequested() ? 'stopped' : 'failed') : 'completed',
        );
    }

    private finish(
        id: string,
        status: AgentChatTask['status'],
        fields: Partial<AgentChatTask> = {},
    ): void {
        const task = this.list.upsert(id, { ...fields, status, canStop: false });
        if (task.kind === 'agent') {
            const items = this.options.host.readTask(id)?.items ?? [];
            const closed = items.flatMap((item) => {
                const settled = closeDanglingItem(item);
                return settled ? [{ op: 'upsertItem' as const, item: settled }] : [];
            });
            if (closed.length > 0) this.options.host.applyTask(id, closed);
            this.streams.delete(id);
        }
    }

    private listedId(claudeId: string): string | undefined {
        return this.known.get(claudeId)?.id;
    }

    /**
     * The Bash row a background shell started, when that row is in the parent timeline.
     */
    private commandRow(toolUseId: string | undefined) {
        const id = toolUseId && clip(toolUseId, 200);
        const item = id && this.options.host.read().items.find((candidate) => candidate.id === id);
        return item && item.type === 'command' ? item : undefined;
    }

    private listShell(claudeId: string, known: KnownTask): void {
        const id = clip(claudeId, 200);
        this.known.set(claudeId, { ...known, id });
        this.claudeIds.set(id, claudeId);
        const row = this.commandRow(known.toolUseId);
        const command = stringField(row?.command);
        // The Bash call's description names the shell the way the Agent did; the command line stays for its tab.
        const description =
            stringField(row?.description) ??
            (known.description === command ? undefined : stringField(known.description));
        this.list.upsert(id, {
            kind: 'shell',
            title: description ?? command ?? 'Background command',
            ...(description && command && { command: clip(command, 10_000) }),
            ...(known.toolUseId && { itemId: clip(known.toolUseId, 200) }),
            isBackground: true,
            canStop: true,
        });
        this.shellOutput.start();
    }

    private onTaskStarted(message: Json): void {
        const claudeId = stringField(message.task_id);
        if (!claudeId || message.ambient === true || message.skip_transcript === true) return;
        const toolUseId = stringField(message.tool_use_id);
        const description = text(message.description);
        const agentType = stringField(message.subagent_type);
        // A workflow always runs in the background (its tool call returns at once) and reports no `is_backgrounded`.
        const isWorkflow = message.task_type === 'local_workflow';
        const isAgent =
            isWorkflow ||
            message.task_type === 'local_agent' ||
            (toolUseId !== undefined && this.list.get(clip(toolUseId, 200))?.kind === 'agent');
        if (isAgent) {
            const id = clip(toolUseId ?? claudeId, 200);
            this.known.set(claudeId, {
                id,
                kind: 'agent',
                ...(toolUseId && { toolUseId }),
                description,
                ...(isWorkflow && { isWorkflow }),
            });
            this.claudeIds.set(id, claudeId);
            const existing = this.list.get(id);
            const isBackground =
                isWorkflow ||
                (typeof message.is_backgrounded === 'boolean'
                    ? message.is_backgrounded
                    : (existing?.isBackground ?? false));
            // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- an empty description names nothing
            const agentTitle = description || existing?.title || agentType || 'Agent';
            this.list.upsert(id, {
                kind: 'agent',
                title: isWorkflow ? (stringField(message.workflow_name) ?? 'Workflow') : agentTitle,
                ...(toolUseId && { itemId: id }),
                ...(agentType && { agentType }),
                isBackground,
                canStop: isBackground,
            });
            return;
        }
        if (message.task_type !== 'local_bash') return;
        const known: KnownTask = { kind: 'shell', ...(toolUseId && { toolUseId }), description };
        // A foreground command blocks its turn; it is listed only once it moves to the background.
        if (message.is_backgrounded === false) this.known.set(claudeId, known);
        else this.listShell(claudeId, known);
    }

    private onTaskUpdated(message: Json): void {
        const claudeId = stringField(message.task_id);
        const patch = isRecord(message.patch) ? message.patch : undefined;
        if (!claudeId || !patch) return;
        const known = this.known.get(claudeId);
        const status = claudeTaskStatus(patch.status);
        if (!known?.id) {
            if (known && patch.is_backgrounded === true && (!status || status === 'running'))
                this.listShell(claudeId, known);
            else if (status && status !== 'running') this.known.delete(claudeId);
            return;
        }
        const task = this.list.get(known.id);
        if (!task) return;
        if (status && status !== 'running') {
            this.finish(task.id, status);
            return;
        }
        const isBackground =
            typeof patch.is_backgrounded === 'boolean' ? patch.is_backgrounded : task.isBackground;
        const description = stringField(patch.description);
        this.list.upsert(task.id, {
            isBackground,
            ...(task.status === 'running' && { canStop: task.kind === 'shell' || isBackground }),
            ...(description &&
                task.kind === 'agent' &&
                !known.isWorkflow && { title: description }),
        });
    }

    private onTaskProgress(message: Json): void {
        const claudeId = stringField(message.task_id);
        const id = claudeId && this.listedId(claudeId);
        if (!id || this.list.get(id)?.status !== 'running') return;
        const usage = claudeTaskUsage(message.usage);
        const lastToolName = stringField(message.last_tool_name);
        const summary = stringField(message.summary);
        this.list.upsert(id, {
            ...(usage && { usage }),
            ...(lastToolName && { lastToolName }),
            ...(summary && { summary }),
        });
    }

    private onTaskNotification(message: Json): void {
        const claudeId = stringField(message.task_id);
        if (!claudeId) return;
        const id = this.listedId(claudeId);
        const status = claudeTaskStatus(message.status);
        if (!id || !status || status === 'running') {
            if (!id) this.known.delete(claudeId);
            return;
        }
        // A stop can report zero tokens and tool uses; it must not erase what progress frames already counted.
        const reported = claudeTaskUsage(message.usage);
        const prior = this.list.get(id)?.usage;
        const usage =
            prior && !reported?.totalTokens && !reported?.toolUses
                ? {
                      ...prior,
                      ...(reported?.durationMs !== undefined && {
                          durationMs: reported.durationMs,
                      }),
                  }
                : reported;
        const summary = stringField(message.summary);
        this.finish(id, status, { ...(usage && { usage }), ...(summary && { summary }) });
        if (this.list.get(id)?.kind === 'shell') this.shellOutput.readFinal(id);
    }

    /**
     * REPLACE semantics: the payload is every live background task. A listed background task that was in an earlier
     * payload and is missing now ended without a notification this session saw.
     */
    private onBackgroundTasksChanged(message: Json): void {
        if (!Array.isArray(message.tasks)) return;
        const live = new Map<string, Json>();
        for (const entry of message.tasks) {
            const claudeId = isRecord(entry) ? stringField(entry.task_id) : undefined;
            if (claudeId && isRecord(entry) && entry.ambient !== true) live.set(claudeId, entry);
        }
        for (const [claudeId, entry] of live) {
            this.inLevel.add(claudeId);
            const known = this.known.get(claudeId);
            if (known?.id) {
                const task = this.list.get(known.id);
                if (task?.status === 'running' && !task.isBackground)
                    this.list.upsert(task.id, { isBackground: true, canStop: true });
            } else if (entry.task_type === 'local_bash')
                this.listShell(claudeId, {
                    kind: 'shell',
                    ...(known?.toolUseId && { toolUseId: known.toolUseId }),
                    description: known?.description ?? text(entry.description),
                });
            // An unknown subagent waits for its task_started, which names the tool call that keys it.
        }
        for (const [id, claudeId] of this.claudeIds) {
            if (live.has(claudeId) || !this.inLevel.has(claudeId)) continue;
            this.inLevel.delete(claudeId);
            const task = this.list.get(id);
            if (task?.status === 'running' && task.isBackground) this.finish(id, 'stopped');
        }
    }

    private onTaskFrame(message: Json): boolean {
        switch (message.subtype) {
            case 'task_started': {
                this.onTaskStarted(message);
                return true;
            }
            case 'task_updated': {
                this.onTaskUpdated(message);
                return true;
            }
            case 'task_progress': {
                this.onTaskProgress(message);
                return true;
            }
            case 'task_notification': {
                this.onTaskNotification(message);
                return true;
            }
            case 'background_tasks_changed': {
                this.onBackgroundTasksChanged(message);
                return true;
            }
            default: {
                return false;
            }
        }
    }

    /**
     * The listed task a subagent frame belongs to. A resumed subagent (`SendMessage` to a finished or orphaned one) is
     * listed under the resuming call, but its frames still name the original `Agent` call as `parent_tool_use_id`;
     * keying by that alone left a phantom task running forever. Assistant and user frames carry the subagent's
     * `agent_id` (its unchanging `task_id`), which names the run actually listed; `stream_event` frames carry none, so
     * they follow the route an earlier frame of the same parent established.
     */
    private childTaskId(message: Json, parent: string): string {
        const agentId = stringField(message.agent_id);
        const listed = agentId === undefined ? undefined : this.listedId(agentId);
        if (listed) {
            if (listed === parent) this.childRoutes.delete(parent);
            else this.childRoutes.set(parent, listed);
            return listed;
        }
        return this.childRoutes.get(parent) ?? parent;
    }

    /**
     * The command line of a listed background shell, read from the Bash row that started it. A shell whose row is not
     * in the parent timeline has no known command, even when the Agent named it.
     */
    shellCommand(taskId: string): string | undefined {
        const claudeId = this.claudeIds.get(taskId);
        const known = claudeId === undefined ? undefined : this.known.get(claudeId);
        return known?.kind === 'shell'
            ? stringField(this.commandRow(known.toolUseId)?.command)
            : undefined;
    }

    /**
     * Inspects a top-level assistant frame for subagent tool calls.
     */
    onAssistant(message: Json, taskId?: string): void {
        this.feedback.observeToolUses(message.content, taskId);
        const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
        for (const block of blocks) if (block.type === 'tool_use') this.noteToolUse(block);
    }

    /**
     * Inspects top-level tool results for the end of a foreground subagent.
     */
    onToolResults(content: unknown): void {
        this.feedback.observeToolResults(content);
        if (!Array.isArray(content)) return;
        for (const block of content) {
            const toolUseId =
                isRecord(block) && block.type === 'tool_result'
                    ? stringField(block.tool_use_id)
                    : undefined;
            if (toolUseId && isRecord(block)) this.settleAgentResult(clip(toolUseId, 200), block);
        }
    }

    /**
     * Routes one frame of a subagent's own conversation into the task projection of the run it belongs to.
     */
    onChildMessage(message: Json): void {
        const parent = stringField(message.parent_tool_use_id);
        if (!parent) return;
        const taskId = this.childTaskId(message, clip(parent, 200));
        if (!this.list.get(taskId)) {
            // A partial frame names no `agent_id`, so it cannot tell a resumed run from a new one; its full frame follows.
            if (message.type === 'stream_event') return;
            const row = this.options.host.read().items.find((item) => item.id === taskId);
            this.list.upsert(taskId, {
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
                if (this.feedback.onTaskMessage(taskId, message)) return;
                const body = isRecord(message.message) ? message.message : undefined;
                if (!body) return;
                const stream = this.stream(taskId);
                const { items } = claudeAssistantItems(body, undefined, stream.ids);
                if (items.length > 0) {
                    this.feedback.note(taskId, items);
                    this.options.host.applyTask(
                        taskId,
                        items.map((item) => ({ op: 'upsertItem', item })),
                    );
                }
                stream.settle(items);
                // A subagent may spawn its own subagents.
                this.onAssistant(body, taskId);
                return;
            }
            case 'user': {
                const body = isRecord(message.message) ? message.message : undefined;
                const content = Array.isArray(body?.content) ? body.content : [];
                this.feedback.observeToolResults(content);
                const items = new Map(
                    (this.options.host.readTask(taskId)?.items ?? []).map((item) => [
                        item.id,
                        item,
                    ]),
                );
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
                    if (settled)
                        this.options.host.applyTask(taskId, [{ op: 'upsertItem', item: settled }]);
                    this.settleAgentResult(id, block);
                }
                return;
            }
            default: {
                // Tool progress and other subagent frames are not conversation content.
            }
        }
    }

    /**
     * Handles a `system` frame about tasks. Returns false for any other subtype.
     */
    onSystem(message: Json): boolean {
        const isTaskFrame = this.onTaskFrame(message);
        if (isTaskFrame) this.options.onTasksChanged();
        return isTaskFrame;
    }

    onFeedback(message: Json): boolean {
        return this.feedback.onMessage(message);
    }

    /**
     * How the main timeline labels feedback no subagent claimed: a tool Hook matched to the main Agent's own call is
     * that Agent's, and anything else is the session's.
     */
    feedbackScope(message: Json): 'agent' | 'session' {
        return this.feedback.toolHookOwner(message) === 'main' ? 'agent' : 'session';
    }

    /**
     * Stops one listed task through Claude Code's `stop_task`; its `task_notification` then marks it stopped.
     */
    async stop(taskId: string): Promise<void> {
        const task = this.list.get(taskId) ?? this.list.byItem(taskId);
        const claudeId = task && this.claudeIds.get(task.id);
        if (!claudeId || task.status !== 'running')
            throw new CaxriError('CONFLICT', 'This task is no longer running');
        const query = this.options.query();
        if (!query) throw new CaxriError('UNAVAILABLE', 'Claude Chat is not running');
        await query.stopTask(claudeId);
    }

    close(): void {
        this.shellOutput.close();
        this.feedback.clear();
    }
}
