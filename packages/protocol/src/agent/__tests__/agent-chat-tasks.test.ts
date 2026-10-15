import { describe, expect, it } from 'vitest';

import type { AgentChatTask } from '../agent-chat-contract.js';
import {
    agentChatTaskElapsedMs,
    agentChatTaskGlyphStatus,
    agentChatTasksByItem,
    agentChatTasksLatestEnd,
    agentChatTaskStrip,
    agentChatTaskStripView,
    canStopAgentChatTask,
    findAgentChatTask,
    isAgentChatTaskTitleCommand,
} from '../agent-chat-tasks.js';

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
