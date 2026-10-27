import type { AgentChatItem, AgentChatTask } from '@caxri/protocol';
import { agentChatTasksByItem, agentChatTaskUsageSummary } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import {
    agentChatTaskBilledUsage,
    agentChatTaskKind,
    agentChatTaskLinkForItem,
    agentChatTurnSubagents,
    isAgentChatTaskItemRunning,
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

function toolCall(id: string, name: string, summary?: string): AgentChatItem {
    return {
        id,
        type: 'toolCall',
        name,
        status: 'completed',
        ...(summary !== undefined && { summary }),
    };
}

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

describe('agentChatTurnSubagents', () => {
    it("lists a turn's subagents once each, leaving out shells and ordinary rows", () => {
        const byItem = agentChatTasksByItem([
            task({
                id: 'agent-1',
                itemId: 'toolu-1',
                title: 'Survey the project',
                status: 'completed',
            }),
            task({ id: 'shell-1', kind: 'shell', itemId: 'command-1' }),
        ]);
        const command: AgentChatItem = {
            id: 'command-1',
            type: 'command',
            command: 'bun run dev',
            output: '',
            status: 'completed',
        };
        expect(
            agentChatTurnSubagents(
                [
                    toolCall('read-1', 'Read'),
                    toolCall('toolu-1', 'Task'),
                    command,
                    toolCall('toolu-9', 'Agent'),
                    toolCall('toolu-1', 'Task'),
                ],
                byItem,
            ),
        ).toEqual([
            {
                taskId: 'agent-1',
                itemId: 'toolu-1',
                title: 'Survey the project',
                isRunning: false,
            },
            { taskId: 'toolu-9', itemId: 'toolu-9', title: undefined, isRunning: false },
        ]);
    });

    it('marks a subagent that still runs after its turn ended', () => {
        const byItem = agentChatTasksByItem([
            task({ id: 'agent-1', itemId: 'spawn-1', title: 'Inspect the fixtures' }),
        ]);
        expect(agentChatTurnSubagents([toolCall('spawn-1', 'spawnAgent')], byItem)).toEqual([
            {
                taskId: 'agent-1',
                itemId: 'spawn-1',
                title: 'Inspect the fixtures',
                isRunning: true,
            },
        ]);
    });
    it('names a subagent the live task list no longer knows by the description it was started with', () => {
        const byItem = agentChatTasksByItem([
            task({ id: 'agent-1', itemId: 'toolu-1', title: 'Survey the project' }),
        ]);
        expect(
            agentChatTurnSubagents(
                [
                    toolCall('toolu-1', 'Agent', 'Older description'),
                    toolCall('toolu-2', 'Agent', 'Review the billing plan'),
                    toolCall('toolu-3', 'Agent', ''),
                ],
                byItem,
            ).map((subagent) => subagent.title),
        ).toEqual(['Survey the project', 'Review the billing plan', undefined]);
    });
});

describe('isAgentChatTaskItemRunning', () => {
    it('holds only for a row whose task is still running', () => {
        const byItem = agentChatTasksByItem([
            task({ id: 'a', itemId: 'running' }),
            task({ id: 'b', itemId: 'done', status: 'completed' }),
        ]);
        expect(isAgentChatTaskItemRunning(byItem, toolCall('running', 'Task'))).toBe(true);
        expect(isAgentChatTaskItemRunning(byItem, toolCall('done', 'Task'))).toBe(false);
        expect(isAgentChatTaskItemRunning(undefined, toolCall('running', 'Task'))).toBe(false);
    });
});

describe('agentChatTaskBilledUsage', () => {
    it('shows the billed tokens and cost of the subagent transcript in place of the provider count', () => {
        const billed = {
            provider: 'claude' as const,
            tokens: {
                input: 30,
                output: 9100,
                cacheRead: 620_000,
                cacheWrite: 54_000,
                reasoning: 0,
                total: 683_130,
            },
            costUsd: 0.214,
            models: ['claude-haiku-5-5'],
            unpricedModels: [],
        };
        const reported = task({ id: 'a', usage: { totalTokens: 64_900, toolUses: 12 } });
        const summary = (readout: Parameters<typeof agentChatTaskBilledUsage>[0]) =>
            agentChatTaskUsageSummary(reported, translate, agentChatTaskBilledUsage(readout));
        expect(summary(billed)).toBe('683k tokens · $0.21 · 12 tool uses');
        expect(summary({ ...billed, unpricedModels: ['claude-haiku-5-5'] })).toBe(
            '683k tokens · 12 tool uses',
        );
        expect(summary(null)).toBe('64.9k tokens · 12 tool uses');
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
