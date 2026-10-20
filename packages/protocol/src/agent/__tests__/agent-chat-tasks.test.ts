import { describe, expect, it } from 'vitest';

import type { AgentChatItem, AgentChatTask } from '../agent-chat-contract.js';
import {
    agentChatTaskActivity,
    agentChatTaskElapsedMs,
    agentChatTaskGlyphStatus,
    agentChatTaskIdentity,
    agentChatTasksByItem,
    agentChatTasksLatestEnd,
    agentChatTaskStrip,
    agentChatTaskStripView,
    agentChatTaskUsageSummary,
    canStopAgentChatTask,
    findAgentChatTask,
    isAgentChatTaskTitleCommand,
} from '../agent-chat-tasks.js';
import { isAgentChatSubagentItem } from '../agent-chat-work.js';

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

describe('agentChatTasksByItem', () => {
    it('keys tasks by the item that started them', () => {
        const shell = task({ id: 'shell-1', kind: 'shell', itemId: 'command-1' });
        const byItem = agentChatTasksByItem([shell, task({ id: 'agent-1' })]);
        expect(byItem.keys().toArray()).toEqual(['command-1']);
        expect(byItem.get('command-1')).toBe(shell);
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

describe('agentChatTaskElapsedMs', () => {
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
});

describe('task presentation', () => {
    it('shows a stopped task like an interrupted item', () => {
        expect(agentChatTaskGlyphStatus('stopped')).toBe('interrupted');
        expect(agentChatTaskGlyphStatus('running')).toBe('running');
    });

    it('offers Stop only for a running task the provider can stop', () => {
        expect(canStopAgentChatTask({ canStop: true, status: 'running' })).toBe(true);
        expect(canStopAgentChatTask({ canStop: false, status: 'running' })).toBe(false);
        expect(canStopAgentChatTask({ canStop: true, status: 'completed' })).toBe(false);
    });

    it('sets a shell title in monospace only while it is the command line', () => {
        expect(isAgentChatTaskTitleCommand({ kind: 'shell' })).toBe(true);
        expect(isAgentChatTaskTitleCommand({ kind: 'shell', command: 'bun run dev' })).toBe(false);
        expect(isAgentChatTaskTitleCommand({ kind: 'agent' })).toBe(false);
        expect(isAgentChatTaskTitleCommand(undefined, 'shell')).toBe(true);
    });
});

describe('agentChatTaskStrip', () => {
    it('lists running tasks in start order and ended ones most recent first', () => {
        const strip = agentChatTaskStrip([
            task({ id: 'late', startedAt: 20 }),
            task({ id: 'done', status: 'completed', endedAt: 30 }),
            task({ id: 'early', kind: 'shell', startedAt: 10 }),
            task({ id: 'stopped', status: 'stopped', endedAt: 40 }),
        ]);
        expect(strip.running.map((entry) => entry.id)).toEqual(['early', 'late']);
        expect(strip.ended.map((entry) => entry.id)).toEqual(['stopped', 'done']);
        expect(agentChatTaskStrip(undefined)).toEqual({ running: [], ended: [] });
    });
});

describe('agentChatTaskStripView', () => {
    const none = { dismissedAt: undefined, latestTurnStartedAt: 100 };

    it('lists running work and counts every ended task while anything runs', () => {
        const view = agentChatTaskStripView(
            [task({ id: 'run' }), task({ id: 'old', status: 'completed', endedAt: 10 })],
            none,
        );
        expect(view?.running.map(({ id }) => id)).toEqual(['run']);
        expect(view?.ended.map(({ id }) => id)).toEqual(['old']);
        expect(view?.isDismissible).toBe(false);
    });

    it('keeps work that ended during the latest turn after the last task ends', () => {
        const view = agentChatTaskStripView(
            [
                task({ id: 'before', status: 'completed', endedAt: 50 }),
                task({ id: 'during', status: 'stopped', endedAt: 150 }),
                task({ id: 'unknown', status: 'failed' }),
            ],
            none,
        );
        expect(view?.running).toEqual([]);
        expect(view?.ended.map(({ id }) => id)).toEqual(['during']);
        expect(view?.isDismissible).toBe(true);
    });

    it('hides once the next turn starts, or once dismissed until later work ends', () => {
        const tasks = [task({ id: 'done', status: 'completed', endedAt: 150 })];
        expect(
            agentChatTaskStripView(tasks, { dismissedAt: undefined, latestTurnStartedAt: 200 }),
        ).toBeUndefined();
        expect(
            agentChatTaskStripView(tasks, { dismissedAt: 150, latestTurnStartedAt: 100 }),
        ).toBeUndefined();
        const later = [...tasks, task({ id: 'later', status: 'completed', endedAt: 180 })];
        expect(
            agentChatTaskStripView(later, {
                dismissedAt: 150,
                latestTurnStartedAt: 100,
            })?.ended.map(({ id }) => id),
        ).toEqual(['later']);
    });

    it('shows nothing when idle and the latest turn has no start time', () => {
        expect(
            agentChatTaskStripView([task({ id: 'done', status: 'completed', endedAt: 150 })], {
                dismissedAt: undefined,
                latestTurnStartedAt: undefined,
            }),
        ).toBeUndefined();
        expect(agentChatTaskStripView(undefined, none)).toBeUndefined();
    });
});

describe('agentChatTasksLatestEnd', () => {
    it('returns the newest end time, ignoring tasks without one', () => {
        expect(
            agentChatTasksLatestEnd([
                task({ id: 'a', status: 'completed', endedAt: 20 }),
                task({ id: 'b', status: 'failed' }),
                task({ id: 'c', status: 'stopped', endedAt: 40 }),
            ]),
        ).toBe(40);
        expect(agentChatTasksLatestEnd([])).toBeUndefined();
    });
});

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

describe('agentChatTaskUsageSummary', () => {
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

    it('prefers billed tokens and adds their cost', () => {
        const reported = task({ id: 'a', usage: { totalTokens: 64_900, toolUses: 12 } });
        expect(
            agentChatTaskUsageSummary(reported, undefined, { totalTokens: 683_130, cost: '$0.21' }),
        ).toBe('683k tokens · $0.21 · 12 tool uses');
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
});
