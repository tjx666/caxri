/**
 * Background-work scenarios for the fake Claude Code CLI (`fake-claude-cli.ts`): subagents whose own frames carry
 * `parent_tool_use_id`, background shells and subagents with `task_*` and `background_tasks_changed` frames, and the
 * `stop_task` and `get_task_output` control requests. Kept apart so the CLI stand-in stays readable.
 */
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { FakeClaudeIo } from './fake-claude-io.ts';

type Json = Record<string, unknown>;

interface BackgroundTask {
    kind: 'agent' | 'shell';
    toolUseId: string;
    description: string;
    timer?: NodeJS.Timeout;
}

const tasks = {
    nextTaskId: 1,
    isForwardingSubagentText: false,
    hasPerTaskStop: false,
    background: new Map<string, BackgroundTask>(),
    outputs: new Map<string, string>(),
};

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function childFrame(io: FakeClaudeIo, parent: string, entry: Json): Json {
    return io.frame({ ...entry, parent_tool_use_id: parent });
}

function childAssistant(io: FakeClaudeIo, parent: string, messageId: string, block: Json) {
    if (block.type === 'text' && !tasks.isForwardingSubagentText) return;
    io.send(
        childFrame(io, parent, {
            type: 'assistant',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model: 'fake-haiku',
                content: [block],
                stop_reason: null,
                usage: { input_tokens: 10, output_tokens: 5 },
            },
        }),
    );
}

function childStreamStart(io: FakeClaudeIo, parent: string, messageId: string, text: string) {
    if (!tasks.isForwardingSubagentText) return;
    for (const event of [
        { type: 'message_start', message: { id: messageId } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ])
        io.send(childFrame(io, parent, { type: 'stream_event', event }));
}

function liveBackground(): Json[] {
    return [...tasks.background].map(([taskId, task]) => ({
        task_id: taskId,
        task_type: task.kind === 'agent' ? 'local_agent' : 'local_bash',
        description: task.description,
        ...(task.kind === 'agent' && { subagent_type: 'general-purpose' }),
    }));
}

function endBackground(io: FakeClaudeIo, taskId: string, status: 'completed' | 'stopped') {
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

/**
 * Writes a subagent transcript the way Claude Code does, beside the session transcript.
 */
function recordSubagent(io: FakeClaudeIo, agentId: string, meta: Json, messages: Json[]) {
    fs.mkdirSync(io.subagentDirectory, { recursive: true });
    const base = path.join(io.subagentDirectory, `agent-${agentId}`);
    fs.writeFileSync(`${base}.meta.json`, JSON.stringify(meta));
    let parentUuid: string | null = null;
    const lines = messages.map((message) => {
        const uuid = crypto.randomUUID();
        const type = message.role;
        const line = JSON.stringify({
            parentUuid,
            isSidechain: true,
            agentId,
            uuid,
            type,
            message,
        });
        parentUuid = uuid;
        return line;
    });
    fs.writeFileSync(`${base}.jsonl`, `${lines.join('\n')}\n`);
}

export async function runSubagent(io: FakeClaudeIo, startedAt: number) {
    const toolUseId = `toolu_${crypto.randomUUID()}`;
    const agentId = `a${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const input = {
        description: 'Survey the project',
        prompt: 'List the files in the project.',
        subagent_type: 'general-purpose',
        model: 'fake-haiku',
    };
    io.assistant(`msg_${crypto.randomUUID()}`, {
        type: 'tool_use',
        id: toolUseId,
        name: 'Agent',
        input,
    });
    io.system('task_started', {
        task_id: agentId,
        tool_use_id: toolUseId,
        description: input.description,
        subagent_type: input.subagent_type,
        task_type: 'local_agent',
        is_backgrounded: false,
        prompt: input.prompt,
    });
    const streamed = `msg_${crypto.randomUUID()}`;
    const readId = `toolu_${crypto.randomUUID()}`;
    const looking = { type: 'text', text: 'Looking at the files.' };
    const read = { type: 'tool_use', id: readId, name: 'Read', input: { file_path: 'README.md' } };
    const readResult = { type: 'tool_result', tool_use_id: readId, content: '# Project' };
    const found = { type: 'text', text: 'Found a README.' };
    childStreamStart(io, toolUseId, streamed, 'Looking at ');
    childAssistant(io, toolUseId, streamed, looking);
    childAssistant(io, toolUseId, `msg_${crypto.randomUUID()}`, read);
    await delay(20);
    io.send(
        childFrame(io, toolUseId, {
            type: 'user',
            message: { role: 'user', content: [readResult] },
        }),
    );
    childAssistant(io, toolUseId, `msg_${crypto.randomUUID()}`, found);
    const usage = { total_tokens: 1500, tool_uses: 1, duration_ms: 50 };
    io.system('task_progress', {
        task_id: agentId,
        tool_use_id: toolUseId,
        description: input.description,
        usage,
        last_tool_name: 'Read',
    });
    recordSubagent(
        io,
        agentId,
        { agentType: input.subagent_type, description: input.description, toolUseId },
        [
            { role: 'user', content: input.prompt },
            { id: streamed, role: 'assistant', content: [looking] },
            { id: 'msg_read', role: 'assistant', content: [read] },
            { role: 'user', content: [readResult] },
            { id: 'msg_found', role: 'assistant', content: [found] },
        ],
    );
    io.system('task_notification', {
        task_id: agentId,
        tool_use_id: toolUseId,
        status: 'completed',
        output_file: '',
        summary: 'Found a README.',
        usage,
    });
    io.toolResult(toolUseId, 'Found a README.');
    await io.didStreamFully('The subagent finished.', 0);
    io.result(startedAt, 'done');
}

export function startBackgroundAgent(io: FakeClaudeIo, startedAt: number) {
    const toolUseId = `toolu_${crypto.randomUUID()}`;
    const taskId = `a${tasks.nextTaskId++}`;
    const description = 'Watch the build';
    io.assistant(`msg_${crypto.randomUUID()}`, {
        type: 'tool_use',
        id: toolUseId,
        name: 'Agent',
        input: {
            description,
            prompt: 'Watch the build.',
            subagent_type: 'general-purpose',
            run_in_background: true,
        },
    });
    tasks.background.set(taskId, { kind: 'agent', toolUseId, description });
    io.system('background_tasks_changed', { tasks: liveBackground() });
    io.system('task_started', {
        task_id: taskId,
        tool_use_id: toolUseId,
        description,
        subagent_type: 'general-purpose',
        task_type: 'local_agent',
        is_backgrounded: true,
    });
    io.toolResult(toolUseId, 'Async agent launched successfully.');
    setTimeout(() => {
        if (tasks.background.has(taskId))
            childAssistant(io, toolUseId, `msg_${crypto.randomUUID()}`, {
                type: 'text',
                text: 'Working in the background.',
            });
    }, 50);
    io.result(startedAt, 'done');
}

/**
 * A background Bash command printing a tick every 100 ms. With `finishAfterMs` it ends on its own and wakes the main
 * thread; otherwise it runs until `stop_task`.
 */
export function startBackgroundShell(io: FakeClaudeIo, startedAt: number, finishAfterMs?: number) {
    const toolUseId = `toolu_${crypto.randomUUID()}`;
    const taskId = `b${tasks.nextTaskId++}`;
    const command = finishAfterMs ? 'sleep 0.3' : 'while true; do echo tick; sleep 0.1; done';
    const description = 'Print ticks';
    io.assistant(`msg_${crypto.randomUUID()}`, {
        type: 'tool_use',
        id: toolUseId,
        name: 'Bash',
        input: { command, description, run_in_background: true },
    });
    const task: BackgroundTask = { kind: 'shell', toolUseId, description };
    tasks.background.set(taskId, task);
    tasks.outputs.set(taskId, '');
    let ticks = 0;
    task.timer = setInterval(() => {
        ticks += 1;
        tasks.outputs.set(taskId, `${tasks.outputs.get(taskId) ?? ''}tick ${ticks}\n`);
    }, 100);
    /**
     * The real CLI reports a running Bash command's elapsed time in `tool_progress` frames whose `parent_tool_use_id`
     * is the Bash call itself, though no subagent exists.
     */
    io.send(
        childFrame(io, toolUseId, {
            type: 'tool_progress',
            tool_use_id: toolUseId,
            tool_name: 'Bash',
            elapsed_time_seconds: 1,
            task_id: taskId,
        }),
    );
    io.system('background_tasks_changed', { tasks: liveBackground() });
    io.system('task_started', {
        task_id: taskId,
        tool_use_id: toolUseId,
        description,
        task_type: 'local_bash',
        is_backgrounded: true,
    });
    io.toolResult(toolUseId, `Command running in background with ID: ${taskId}`);
    io.result(startedAt, 'done');
    if (finishAfterMs)
        setTimeout(() => {
            endBackground(io, taskId, 'completed');
            io.startAutoTurn();
        }, finishAfterMs);
}

/**
 * The task side of a control request. `initialize` records which Agent SDK options the host declared, `interrupt` kills
 * background tasks unless the host declared `perTaskStopAffordance` (as the real CLI does), and `stop_task` and
 * `get_task_output` answer for a background task or fail like the real CLI for an unknown one.
 */
export function taskControl(io: FakeClaudeIo, request: Json): { response?: Json; error?: string } {
    const taskId = typeof request.task_id === 'string' ? request.task_id : '';
    switch (request.subtype) {
        case 'initialize': {
            tasks.isForwardingSubagentText = request.forwardSubagentText === true;
            tasks.hasPerTaskStop = request.perTaskStopAffordance === true;
            return {};
        }
        case 'interrupt': {
            if (!tasks.hasPerTaskStop)
                for (const id of tasks.background.keys()) endBackground(io, id, 'stopped');
            return {};
        }
        case 'stop_task': {
            if (!tasks.background.has(taskId)) return { error: `No running task ${taskId}` };
            endBackground(io, taskId, 'stopped');
            return {};
        }
        case 'get_task_output': {
            const output = tasks.outputs.get(taskId);
            if (output === undefined) return { error: `No task ${taskId}` };
            return {
                response: { output, total_bytes: Buffer.byteLength(output), truncated: false },
            };
        }
        default: {
            return {};
        }
    }
}
