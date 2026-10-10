import type { AgentChatItem, AgentChatTask } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatTaskActivity,
    agentChatTaskElapsedMs,
    agentChatTaskGlyphStatus,
    agentChatTaskIdentity,
    agentChatTaskKind,
    agentChatTaskLinkForItem,
    agentChatTasksByItem,
    agentChatTaskStrip,
    agentChatTaskUsageSummary,
    canStopAgentChatTask,
    findAgentChatTask,
    formatAgentChatTaskElapsed,
    isAgentChatSubagentItem,
} from '../agent-chat-tasks';

function task(overrides: Partial<AgentChatTask> & Pick<AgentChatTask, 'id'>): AgentChatTask {
    return {
        kind: 'agent',
        title: 'Explore',
        status: 'running',
        isBackground: false,
        canStop: true,
        ...overrides,
    };
}

function toolCall(id: string, name: string): AgentChatItem {
    return { id, type: 'toolCall', name, status: 'completed' };
}

describe('isAgentChatSubagentItem', () => {
    it.each(['Task', 'Agent', 'spawnAgent', 'spawn_agent'])('recognizes %s rows', (name) => {
        expect(isAgentChatSubagentItem(toolCall('item-1', name))).toBe(true);
    });

    it('ignores other tools and non-tool items', () => {
        expect(isAgentChatSubagentItem(toolCall('item-1', 'Read'))).toBe(false);
        expect(isAgentChatSubagentItem(toolCall('item-1', 'TaskOutput'))).toBe(false);
        expect(
            isAgentChatSubagentItem({
                id: 'item-1',
                type: 'command',
                command: 'ls',
                output: '',
                status: 'completed',
            }),
        ).toBe(false);
    });
});

describe('agentChatTaskLinkForItem', () => {
    const shell = task({ id: 'shell-1', kind: 'shell', itemId: 'command-1' });
    const byItem = agentChatTasksByItem([shell, task({ id: 'agent-1' })]);

    it('links a row to the task it started', () => {
        const command: AgentChatItem = {
            id: 'command-1',
            type: 'command',
            command: 'bun run dev',
            output: '',
            status: 'completed',
        };
        expect(agentChatTaskLinkForItem(command, byItem)).toEqual({
            taskId: 'shell-1',
            task: shell,
        });
    });

    it('keeps a subagent row openable by its own id when no task lists it', () => {
        expect(agentChatTaskLinkForItem(toolCall('toolu-9', 'Task'), byItem)).toEqual({
            taskId: 'toolu-9',
            task: undefined,
        });
    });

    it('leaves ordinary rows unlinked', () => {
        expect(agentChatTaskLinkForItem(toolCall('read-1', 'Read'), byItem)).toBeUndefined();
    });
});

describe('findAgentChatTask', () => {
    it('matches the task id first, then the item that started it', () => {
        const tasks = [task({ id: 'a', itemId: 'b' }), task({ id: 'b' })];
        expect(findAgentChatTask(tasks, 'b')?.id).toBe('b');
        expect(findAgentChatTask([task({ id: 'a', itemId: 'item' })], 'item')?.id).toBe('a');
        expect(findAgentChatTask(undefined, 'a')).toBeUndefined();
    });
});

describe('task timing and usage', () => {
    it('counts a running task up from its start and prefers the provider duration once ended', () => {
        expect(agentChatTaskElapsedMs(task({ id: 'a', startedAt: 1000 }), 6000)).toBe(5000);
        expect(
            agentChatTaskElapsedMs(
                task({ id: 'a', status: 'completed', startedAt: 1000, endedAt: 4000 }),
                9000,
            ),
        ).toBe(3000);
        expect(
            agentChatTaskElapsedMs(
                task({
                    id: 'a',
                    status: 'completed',
                    startedAt: 1000,
                    usage: { durationMs: 2500 },
                }),
                9000,
            ),
        ).toBe(2500);
        expect(agentChatTaskElapsedMs(task({ id: 'a' }), 9000)).toBeUndefined();
    });

    it('hides elapsed time below a second', () => {
        expect(formatAgentChatTaskElapsed(400)).toBeUndefined();
        expect(formatAgentChatTaskElapsed(undefined)).toBeUndefined();
        expect(formatAgentChatTaskElapsed(65_000)).toBe('1m 5s');
    });

    it('summarizes reported usage', () => {
        expect(
            agentChatTaskUsageSummary(
                task({ id: 'a', usage: { totalTokens: 12_300, toolUses: 1 } }),
            ),
        ).toBe('12.3k tokens · 1 tool use');
        expect(agentChatTaskUsageSummary(task({ id: 'a', usage: { toolUses: 4 } }))).toBe(
            '4 tool uses',
        );
        expect(agentChatTaskUsageSummary(task({ id: 'a' }))).toBeUndefined();
    });
});

describe('task presentation', () => {
    it('joins the agent type and model', () => {
        expect(agentChatTaskIdentity({ agentType: 'general-purpose', model: 'sonnet' })).toBe(
            'general-purpose · sonnet',
        );
        expect(agentChatTaskIdentity({})).toBeUndefined();
        expect(agentChatTaskIdentity(undefined)).toBeUndefined();
    });

    it('shows a stopped task like an interrupted item', () => {
        expect(agentChatTaskGlyphStatus('stopped')).toBe('interrupted');
        expect(agentChatTaskGlyphStatus('running')).toBe('running');
    });

    it('describes what a task is doing', () => {
        expect(agentChatTaskActivity({ status: 'running', summary: ' Reading files ' })).toBe(
            'Reading files',
        );
        expect(agentChatTaskActivity({ status: 'running', lastToolName: 'Grep' })).toBe(
            'Using Grep',
        );
        expect(
            agentChatTaskActivity({ status: 'completed', lastToolName: 'Grep' }),
        ).toBeUndefined();
    });

    it('offers Stop only for a running task the provider can stop', () => {
        expect(canStopAgentChatTask({ canStop: true, status: 'running' })).toBe(true);
        expect(canStopAgentChatTask({ canStop: false, status: 'running' })).toBe(false);
        expect(canStopAgentChatTask({ canStop: true, status: 'completed' })).toBe(false);
    });
});

describe('agentChatTaskStrip', () => {
    it('lists running tasks in start order and counts the ended ones', () => {
        const strip = agentChatTaskStrip([
            task({ id: 'late', startedAt: 20 }),
            task({ id: 'done', status: 'completed' }),
            task({ id: 'early', kind: 'shell', startedAt: 10 }),
            task({ id: 'stopped', status: 'stopped' }),
        ]);
        expect(strip.running.map((entry) => entry.id)).toEqual(['early', 'late']);
        expect(strip.endedCount).toBe(2);
        expect(agentChatTaskStrip(undefined)).toEqual({ running: [], endedCount: 0 });
    });
});

describe('agentChatTaskKind', () => {
    it('trusts the task list, then infers from the projection', () => {
        expect(agentChatTaskKind({ kind: 'shell' }, { items: [] })).toBe('shell');
        expect(agentChatTaskKind(undefined, { items: [], output: 'ok' })).toBe('shell');
        expect(agentChatTaskKind(undefined, { items: [] })).toBe('agent');
        expect(agentChatTaskKind(undefined, undefined)).toBe('agent');
    });
});
