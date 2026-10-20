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
    agentChatTaskPillIds,
    agentChatTaskRow,
    agentChatTaskSheetPill,
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

describe('agentChatTaskSheetPill', () => {
    it('keeps listing the tasks an open sheet showed once the last one ends and the pill goes', () => {
        const listed = agentChatTaskPillIds(
            agentChatTaskPill({ tasks: [task({ id: 'a', startedAt: 1 })] }),
        );
        const finished = [task({ id: 'a', startedAt: 1, status: 'completed', endedAt: 40 })];
        const pill = agentChatTaskPill({ tasks: finished });
        expect(pill).toBeUndefined();
        expect(agentChatTaskSheetPill(pill, listed, finished)).toMatchObject({
            running: [],
            ended: [{ id: 'a', status: 'completed' }],
            label: '1 ended',
        });
    });

    it('lists the pill itself while there is one, and nothing for tasks the Chat no longer has', () => {
        const tasks = [task({ id: 'b' })];
        const pill = agentChatTaskPill({ tasks });
        expect(agentChatTaskSheetPill(pill, ['a'], tasks)).toBe(pill);
        expect(agentChatTaskSheetPill(undefined, ['gone'], tasks)).toBeUndefined();
    });
});

describe('agentChatTaskPill', () => {
    it('counts running and ended work while anything runs', () => {
        const pill = agentChatTaskPill({
            tasks: [
                task({ id: 'a', startedAt: 1 }),
                task({ id: 'b', status: 'completed', endedAt: 5 }),
            ],
        });
        expect(pill?.label).toBe('1 running · 1 ended');
    });

    it('hides once the last task ends', () => {
        expect(
            agentChatTaskPill({ tasks: [task({ id: 'a', status: 'failed', endedAt: 20 })] }),
        ).toBeUndefined();
    });

    it('shows nothing for a Chat without tasks, such as Grok Build', () => {
        expect(agentChatTaskPill({})).toBeUndefined();
        expect(agentChatTaskPill(undefined)).toBeUndefined();
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

    it("lists a subagent's messages and work in order, without its prompt or blank messages", () => {
        const read = {
            id: 'w1',
            type: 'toolCall' as const,
            name: 'Read',
            status: 'completed' as const,
        };
        expect(
            agentChatTaskDetailContent(
                { kind: 'agent', status: 'running' },
                detail({
                    items: [
                        { id: 'u1', type: 'userMessage', text: 'Find the README' },
                        { id: 'm1', type: 'agentMessage', text: 'First', streaming: false },
                        read,
                        { id: 'm2', type: 'agentMessage', text: ' ', streaming: true },
                    ],
                }),
            ),
        ).toEqual({
            kind: 'transcript',
            entries: [
                { kind: 'message', id: 'm1', text: 'First' },
                { kind: 'work', id: 'w1', item: read },
            ],
            notes: [],
        });
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
