import type { AgentChatTask, AgentChatTaskSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatTaskLink,
    publishAgentChatTaskLinks,
    withdrawAgentChatTaskLinks,
} from '../agent-chat-task-links';
import {
    agentChatTaskDetailContent,
    agentChatTaskPill,
    agentChatTaskRow,
} from '../agent-chat-tasks';

function task(overrides: Partial<AgentChatTask> & Pick<AgentChatTask, 'id'>): AgentChatTask {
    return {
        kind: 'shell',
        title: 'bun run dev',
        status: 'running',
        isBackground: true,
        canStop: true,
        ...overrides,
    };
}

const detail = (overrides: Partial<AgentChatTaskSnapshot> = {}): AgentChatTaskSnapshot => ({
    terminalId: 'terminal-1',
    taskId: 'task-1',
    revision: 1,
    truncated: false,
    items: [],
    ...overrides,
});

describe('agentChatTaskPill', () => {
    it('labels paused work Waiting while retaining its active count and Stop', () => {
        const waiting = task({ id: 'paused', status: 'waiting', startedAt: 1 });
        expect(agentChatTaskPill({ tasks: [waiting], turns: [] }, undefined)?.label).toBe(
            '1 active',
        );
        expect(agentChatTaskRow(waiting, 2000)).toMatchObject({
            statusLabel: 'Waiting',
            canStop: true,
        });
    });

    it('counts running and ended work while anything runs', () => {
        const pill = agentChatTaskPill(
            {
                tasks: [
                    task({ id: 'a', startedAt: 1 }),
                    task({ id: 'b', status: 'completed', endedAt: 5 }),
                ],
                turns: [{ id: 'turn-1', status: 'running', startedAt: 10 }],
            },
            undefined,
        );
        expect(pill?.label).toBe('1 active · 1 ended');
        expect(pill?.isDismissible).toBe(false);
    });

    it('keeps work that ended during the latest turn until dismissed', () => {
        const snapshot = {
            tasks: [task({ id: 'a', status: 'failed', endedAt: 20 })],
            turns: [{ id: 'turn-1', status: 'completed' as const, startedAt: 10 }],
        };
        expect(agentChatTaskPill(snapshot, undefined)).toMatchObject({
            label: '1 ended',
            isDismissible: true,
        });
        expect(agentChatTaskPill(snapshot, 20)).toBeUndefined();
    });

    it('shows nothing for a Chat without tasks, such as Grok Build', () => {
        expect(agentChatTaskPill({ turns: [] }, undefined)).toBeUndefined();
        expect(agentChatTaskPill(undefined, undefined)).toBeUndefined();
    });
});

describe('agentChatTaskRow', () => {
    it('titles a shell by its command in monospace and counts up while it runs', () => {
        expect(agentChatTaskRow(task({ id: 'a', startedAt: 1_000 }), 13_000)).toEqual({
            title: 'bun run dev',
            isCommandTitle: true,
            statusLabel: 'Running',
            elapsed: '12s',
            summary: undefined,
            canStop: true,
            accessibilityLabel: 'Background shell. bun run dev. Running, 12s.',
        });
    });

    it('names an untitled subagent and offers no Stop once it ended', () => {
        const row = agentChatTaskRow(
            task({ id: 'a', kind: 'agent', title: '', status: 'stopped', summary: ' Done ' }),
            0,
        );
        expect(row).toMatchObject({
            title: 'Subagent',
            isCommandTitle: false,
            statusLabel: 'Stopped',
            elapsed: undefined,
            summary: 'Done',
            canStop: false,
        });
    });
});

describe('agentChatTaskDetailContent', () => {
    it("shows a shell's output tail and says what is cut or no longer live", () => {
        expect(
            agentChatTaskDetailContent(
                { kind: 'shell', status: 'running' },
                detail({ output: 'ready\n\n', truncated: true, isOutputCapped: true }),
            ),
        ).toEqual({
            kind: 'output',
            text: 'ready',
            notes: [
                'Earlier output is on your computer.',
                'The provider stopped streaming this output, so it is no longer live.',
            ],
        });
        expect(
            agentChatTaskDetailContent({ kind: 'shell', status: 'completed' }, detail()),
        ).toMatchObject({ kind: 'empty', text: 'No output' });
    });

    it("shows a subagent's latest message", () => {
        expect(
            agentChatTaskDetailContent(
                { kind: 'agent', status: 'running' },
                detail({
                    items: [
                        { id: 'm1', type: 'agentMessage', text: 'First', streaming: false },
                        { id: 'm2', type: 'agentMessage', text: ' ', streaming: true },
                    ],
                }),
            ),
        ).toEqual({ kind: 'message', text: 'First', notes: [] });
        expect(
            agentChatTaskDetailContent({ kind: 'agent', status: 'running' }, detail()),
        ).toMatchObject({ kind: 'empty', text: 'No messages yet' });
    });
});

describe('agent chat task links', () => {
    it('finds the task a command row started while its Chat publishes it', () => {
        const shell = task({ id: 'task-1', itemId: 'command-1' });
        publishAgentChatTaskLinks('terminal-1', [shell, task({ id: 'task-2' })], true);
        const link = agentChatTaskLink('command-1');
        expect(link).toEqual({ terminalId: 'terminal-1', task: shell, canControl: true });
        publishAgentChatTaskLinks('terminal-1', [shell], true);
        expect(agentChatTaskLink('command-1')).toBe(link);
        publishAgentChatTaskLinks('terminal-1', [], true);
        expect(agentChatTaskLink('command-1')).toBeUndefined();
        publishAgentChatTaskLinks('terminal-1', [shell], false);
        withdrawAgentChatTaskLinks('terminal-2');
        expect(agentChatTaskLink('command-1')?.canControl).toBe(false);
        withdrawAgentChatTaskLinks('terminal-1');
        expect(agentChatTaskLink('command-1')).toBeUndefined();
    });
});
