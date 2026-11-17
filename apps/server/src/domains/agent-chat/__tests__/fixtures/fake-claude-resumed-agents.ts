/**
 * Fake Claude Code CLI scenarios for background subagents that come back to life after an earlier run ended: one a
 * `SendMessage` resumes, and one that resumes on its own after waiting on its own background work.
 */
import crypto from 'node:crypto';

import type { FakeClaudeIo } from './fake-claude-io.ts';
import {
    childAssistant,
    childFrame,
    childStreamStart,
    endBackground,
    liveBackground,
    tasks,
} from './fake-claude-task-state.ts';

/**
 * A `SendMessage` that resumes a background subagent a previous Claude Code process launched, as after a Chat restart.
 * Like Claude Code, the resumed run's task frames name the `SendMessage` call, while the subagent's own frames still
 * name the original `Agent` call (one this process never reported) as `parent_tool_use_id`; its assistant frames carry
 * the task's `agent_id`, its `stream_event` frames do not.
 */
export function resumeBackgroundAgent(io: FakeClaudeIo, startedAt: number) {
    const sendId = `toolu_${crypto.randomUUID()}`;
    const originalId = `toolu_${crypto.randomUUID()}`;
    const agentId = `a${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const description = 'Audit the storage layer';
    io.assistant(`msg_${crypto.randomUUID()}`, {
        type: 'tool_use',
        id: sendId,
        name: 'SendMessage',
        input: { to: agentId, summary: 'Resume the audit', message: 'Resume the audit.' },
    });
    tasks.background.set(agentId, { kind: 'agent', toolUseId: sendId, description });
    io.system('background_tasks_changed', { tasks: liveBackground() });
    io.system('task_started', {
        task_id: agentId,
        tool_use_id: sendId,
        description,
        subagent_type: 'general-purpose',
        task_type: 'local_agent',
        is_backgrounded: true,
    });
    io.toolResult(sendId, JSON.stringify({ success: true, resumedAgentId: agentId }));
    io.result(startedAt, 'done');
    setTimeout(() => {
        const messageId = `msg_${crypto.randomUUID()}`;
        childStreamStart(io, originalId, messageId, 'Resuming ');
        io.send(
            childFrame(io, originalId, {
                type: 'assistant',
                agent_id: agentId,
                message: {
                    id: messageId,
                    type: 'message',
                    role: 'assistant',
                    model: 'fake-haiku',
                    content: [{ type: 'text', text: 'Resuming the audit.' }],
                    stop_reason: null,
                    usage: { input_tokens: 10, output_tokens: 5 },
                },
            }),
        );
    }, 50);
    setTimeout(() => {
        endBackground(io, agentId, 'completed');
        io.startAutoTurn();
    }, 300);
}

/**
 * A background subagent that pauses on background work of its own, then resumes. Like Claude Code, the pause reports
 * the task `completed` with an interim summary and drops it from the level; the resume flips the same `task_id` back to
 * `running` through `task_updated`, rejoins the level, and keeps working until `stop_task`.
 */
export function startWaitingBackgroundAgent(io: FakeClaudeIo, startedAt: number) {
    const toolUseId = `toolu_${crypto.randomUUID()}`;
    const taskId = `a${tasks.nextTaskId++}`;
    const description = 'Fix the review findings';
    io.assistant(`msg_${crypto.randomUUID()}`, {
        type: 'tool_use',
        id: toolUseId,
        name: 'Agent',
        input: {
            description,
            prompt: 'Fix the review findings.',
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
    io.result(startedAt, 'done');
    setTimeout(() => {
        tasks.background.delete(taskId);
        io.system('task_updated', {
            task_id: taskId,
            patch: { status: 'completed', end_time: Date.now() },
        });
        io.system('task_notification', {
            task_id: taskId,
            tool_use_id: toolUseId,
            status: 'completed',
            output_file: '',
            summary: `Agent "${description}" is waiting on its own background work`,
            usage: { total_tokens: 4000, tool_uses: 3, duration_ms: 100 },
        });
        io.system('background_tasks_changed', { tasks: liveBackground() });
    }, 100);
    setTimeout(() => {
        tasks.background.set(taskId, { kind: 'agent', toolUseId, description });
        io.system('task_updated', { task_id: taskId, patch: { status: 'running' } });
        io.system('background_tasks_changed', { tasks: liveBackground() });
        childAssistant(io, toolUseId, `msg_${crypto.randomUUID()}`, {
            type: 'tool_use',
            id: `toolu_${crypto.randomUUID()}`,
            name: 'Edit',
            input: { file_path: 'README.md' },
        });
        io.system('task_progress', {
            task_id: taskId,
            tool_use_id: toolUseId,
            description,
            usage: { total_tokens: 6000, tool_uses: 4, duration_ms: 300 },
            last_tool_name: 'Edit',
        });
    }, 300);
}
