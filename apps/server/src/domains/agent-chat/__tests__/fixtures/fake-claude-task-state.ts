/**
 * Shared state and frame helpers for the fake Claude Code CLI's background-work scenarios: the live background task set
 * behind `background_tasks_changed`, and the subagent frames that carry `parent_tool_use_id`.
 */
import type { FakeClaudeIo } from './fake-claude-io.ts';

export type Json = Record<string, unknown>;

export interface BackgroundTask {
    kind: 'agent' | 'shell' | 'workflow';
    toolUseId: string;
    description: string;
    timer?: NodeJS.Timeout;
}

export const tasks = {
    nextTaskId: 1,
    isForwardingSubagentText: false,
    hasPerTaskStop: false,
    background: new Map<string, BackgroundTask>(),
    outputs: new Map<string, string>(),
};

/**
 * The resolved model id a subagent's responses carry, unlike the `fake-haiku` alias its spawning call asks for.
 */
export const FAKE_SUBAGENT_MODEL = 'fake-haiku-1-0';

export function childFrame(io: FakeClaudeIo, parent: string, entry: Json): Json {
    return io.frame({ ...entry, parent_tool_use_id: parent });
}

export function childAssistant(io: FakeClaudeIo, parent: string, messageId: string, block: Json) {
    if (block.type === 'text' && !tasks.isForwardingSubagentText) return;
    io.send(
        childFrame(io, parent, {
            type: 'assistant',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model: FAKE_SUBAGENT_MODEL,
                content: [block],
                stop_reason: null,
                usage: { input_tokens: 10, output_tokens: 5 },
            },
        }),
    );
}

export function childStreamStart(
    io: FakeClaudeIo,
    parent: string,
    messageId: string,
    text: string,
) {
    if (!tasks.isForwardingSubagentText) return;
    for (const event of [
        { type: 'message_start', message: { id: messageId } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ])
        io.send(childFrame(io, parent, { type: 'stream_event', event }));
}

const TASK_TYPES = {
    agent: 'local_agent',
    shell: 'local_bash',
    workflow: 'local_workflow',
} as const;

export function liveBackground(): Json[] {
    return [...tasks.background].map(([taskId, task]) => ({
        task_id: taskId,
        task_type: TASK_TYPES[task.kind],
        description: task.description,
        ...(task.kind === 'agent' && { subagent_type: 'general-purpose' }),
    }));
}

export function endBackground(io: FakeClaudeIo, taskId: string, status: 'completed' | 'stopped') {
    const task = tasks.background.get(taskId);
    if (!task) return;
    clearInterval(task.timer);
    tasks.background.delete(taskId);
    io.system('task_updated', {
        task_id: taskId,
        patch: { status: status === 'stopped' ? 'killed' : 'completed', end_time: Date.now() },
    });
    io.system('task_notification', {
        task_id: taskId,
        tool_use_id: task.toolUseId,
        status,
        output_file: '',
        summary: status === 'stopped' ? 'Stopped' : 'Finished',
        usage: { total_tokens: 0, tool_uses: 0, duration_ms: 300 },
    });
    io.system('background_tasks_changed', { tasks: liveBackground() });
}
