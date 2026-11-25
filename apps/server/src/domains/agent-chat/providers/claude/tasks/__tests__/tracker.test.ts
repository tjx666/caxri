import type {
    AgentChatItem,
    AgentChatSnapshot,
    AgentChatTask,
    AgentChatTaskSnapshot,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentChatSessionHost } from '../../../../chat-provider';
import { ClaudeTasks } from '../tracker';

/**
 * A host that keeps only what `ClaudeTasks` reads back: the parent timeline, the task list, and each task's items.
 */
function harness() {
    let items: AgentChatItem[] = [];
    let tasks: AgentChatTask[] = [];
    const taskItems = new Map<string, AgentChatItem[]>();
    const host = {
        read: () => ({ items, tasks }) as unknown as AgentChatSnapshot,
        apply: (operations) => {
            for (const operation of operations) {
                if (operation.op === 'state' && operation.state.tasks)
                    tasks = operation.state.tasks;
                else if (operation.op === 'upsertItem')
                    items = [...items.filter(({ id }) => id !== operation.item.id), operation.item];
            }
        },
        applyTask: (taskId, operations) => {
            const current = taskItems.get(taskId) ?? [];
            for (const operation of operations)
                if (operation.op === 'upsertItem') current.push(operation.item);
            taskItems.set(taskId, current);
        },
        readTask: (taskId) => {
            const current = taskItems.get(taskId);
            return current && ({ items: current } as unknown as AgentChatTaskSnapshot);
        },
    } satisfies Pick<AgentChatSessionHost, 'apply' | 'applyTask' | 'read' | 'readTask'>;
    const claudeTasks = new ClaudeTasks({
        host: host as unknown as AgentChatSessionHost,
        query: () => {},
        takeDeclined: () => false,
        isInterruptRequested: () => false,
        onTasksChanged: () => {},
    });
    return { claudeTasks, host, tasks: () => tasks, taskItems };
}

const COMMAND = 'until [ "$(uptime)" ]; do sleep 20; done; git push';

describe('ClaudeTasks background shells', () => {
    it('knows the command of a background shell a subagent started, after the subagent leaves', () => {
        const { claudeTasks, tasks, taskItems } = harness();
        claudeTasks.onAssistant({
            content: [
                {
                    type: 'tool_use',
                    id: 'agent-call',
                    name: 'Agent',
                    input: { description: 'Push the batch', run_in_background: true },
                },
            ],
        });
        claudeTasks.onChildMessage({
            type: 'assistant',
            parent_tool_use_id: 'agent-call',
            message: {
                content: [
                    {
                        type: 'tool_use',
                        id: 'bash-call',
                        name: 'Bash',
                        input: {
                            command: COMMAND,
                            description: 'Push when load drops',
                            run_in_background: true,
                        },
                    },
                ],
            },
        });
        claudeTasks.onSystem({
            subtype: 'task_started',
            task_id: 'shell-1',
            task_type: 'local_bash',
            tool_use_id: 'bash-call',
            description: COMMAND,
        });

        expect(tasks().find((task) => task.id === 'shell-1')).toMatchObject({
            kind: 'shell',
            title: 'Push when load drops',
            command: COMMAND,
        });
        // The subagent's projection may be evicted once it ends; the shell it started keeps running.
        taskItems.clear();
        expect(claudeTasks.shellCommand('shell-1')).toBe(COMMAND);
    });

    it('leaves a shell with no Bash row in any timeline without a command', () => {
        const { claudeTasks } = harness();
        claudeTasks.onSystem({
            subtype: 'task_started',
            task_id: 'shell-2',
            task_type: 'local_bash',
            tool_use_id: 'unknown-call',
            description: 'watch',
        });
        expect(claudeTasks.shellCommand('shell-2')).toBeUndefined();
    });
});
