import { describe, expect, it } from 'vitest';

import type { AgentChatItem, AgentChatTask } from '../../agent/agent-chat-contract.js';
import { agentChatSnapshotSchema } from '../../agent/agent-chat-contract.js';
import { agentChatPatchSchema } from '../../agent/agent-chat-patch-contract.js';
import { agentChatTaskSnapshotSchema } from '../../agent/agent-chat-task-contract.js';
import {
    clipAgentChatPatchForMobile,
    clipAgentChatTasksForMobile,
    clipAgentChatTaskSnapshotForMobile,
    MOBILE_AGENT_CHAT_CLIP_MARKER,
    MOBILE_AGENT_CHAT_ENDED_TASKS_MAX_ITEMS,
    MOBILE_AGENT_CHAT_MAX_BYTES,
    MOBILE_AGENT_CHAT_TASK_OUTPUT_MAX_BYTES,
    MOBILE_AGENT_CHAT_TASK_SUMMARY_MAX_LENGTH,
    MOBILE_AGENT_CHAT_TASK_TITLE_MAX_LENGTH,
    MOBILE_AGENT_CHAT_TASK_WORKFLOW_MAX_BYTES,
    MOBILE_AGENT_CHAT_TASKS_MAX_ITEMS,
    MOBILE_AGENT_CHAT_WORKFLOW_ERROR_MAX_LENGTH,
    MOBILE_AGENT_CHAT_WORKFLOW_LABEL_MAX_LENGTH,
    MOBILE_AGENT_CHAT_WORKFLOW_RESULT_MAX_LENGTH,
    MOBILE_AGENT_CHAT_WORKFLOWS_MAX_BYTES,
    mobileAgentChatMethods,
    windowAgentChatSnapshotForMobile,
} from '../mobile-contract.js';

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

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

describe('mobile background tasks', () => {
    it('keeps every running task and the most recently ended ones, in Desktop order', () => {
        const ended = Array.from({ length: 15 }, (_, index) =>
            task({ id: `ended-${index}`, status: 'completed', endedAt: index }),
        );
        const clipped = clipAgentChatTasksForMobile([
            task({ id: 'run-1', startedAt: 1 }),
            ...ended,
            task({ id: 'run-2', startedAt: 2 }),
        ]);
        expect(clipped.map(({ id }) => id)).toEqual([
            'run-1',
            ...ended.slice(-MOBILE_AGENT_CHAT_ENDED_TASKS_MAX_ITEMS).map(({ id }) => id),
            'run-2',
        ]);
    });

    it('keeps the newest started running tasks when more run than the phone lists', () => {
        const running = Array.from({ length: 30 }, (_, index) =>
            task({ id: `run-${index}`, startedAt: index }),
        );
        const clipped = clipAgentChatTasksForMobile(running);
        expect(clipped).toHaveLength(MOBILE_AGENT_CHAT_TASKS_MAX_ITEMS);
        expect(clipped[0].id).toBe(`run-${30 - MOBILE_AGENT_CHAT_TASKS_MAX_ITEMS}`);
    });

    it('cuts long titles, commands, and summaries to one glance', () => {
        const long = 'x'.repeat(5_000);
        const [clipped] = clipAgentChatTasksForMobile([
            task({ id: 'a', title: long, command: long, summary: long, itemId: 'item-1' }),
        ]);
        expect(clipped.title).toHaveLength(MOBILE_AGENT_CHAT_TASK_TITLE_MAX_LENGTH);
        expect(clipped.title.endsWith(MOBILE_AGENT_CHAT_CLIP_MARKER)).toBe(true);
        expect(clipped.command).toHaveLength(MOBILE_AGENT_CHAT_TASK_TITLE_MAX_LENGTH);
        expect(clipped.summary).toHaveLength(MOBILE_AGENT_CHAT_TASK_SUMMARY_MAX_LENGTH);
        expect(clipped.itemId).toBe('item-1');
        expect(clipAgentChatTasksForMobile([task({ id: 'b' })])).toEqual([task({ id: 'b' })]);
    });

    it('fits Desktop’s largest task list into the window and into a state patch', () => {
        const long = 'y'.repeat(10_000);
        const tasks = Array.from({ length: 50 }, (_, index) =>
            task({
                id: `task-${index}`,
                title: long.slice(0, 1_000),
                command: long,
                summary: long.slice(0, 2_000),
                status: index % 2 === 0 ? 'running' : 'failed',
                startedAt: index,
                endedAt: index,
            }),
        );
        const windowed = windowAgentChatSnapshotForMobile({
            terminalId: 'terminal-1',
            revision: 1,
            status: 'ready',
            truncated: false,
            items: [],
            turns: [],
            requests: [],
            tasks,
        });
        expect(bytes(windowed)).toBeLessThan(MOBILE_AGENT_CHAT_MAX_BYTES);
        expect(agentChatSnapshotSchema.safeParse(windowed).success).toBe(true);
        const patch = clipAgentChatPatchForMobile({
            terminalId: 'terminal-1',
            baseRevision: 1,
            revision: 2,
            operations: [{ op: 'state', state: { tasks } }],
        });
        expect(patch).toBeDefined();
        expect(agentChatPatchSchema.safeParse(patch).success).toBe(true);
    });

    it('leaves room for the transcript after a few workflow runs', () => {
        const members = Array.from({ length: 20 }, (_, index) => ({
            index,
            label: `review:${index}`,
            status: 'completed' as const,
            promptPreview: 'p'.repeat(500),
            resultPreview: 'r'.repeat(2_000),
        }));
        const tasks = Array.from({ length: 3 }, (_, index) =>
            task({
                id: `workflow-${index}`,
                kind: 'agent',
                status: 'completed',
                endedAt: index,
                workflow: { phases: [{ title: 'Review' }], members, result: 'w'.repeat(8_000) },
            }),
        );
        const message: AgentChatItem = {
            id: 'reply',
            type: 'agentMessage',
            text: 'Done.',
            streaming: false,
        };
        const windowed = windowAgentChatSnapshotForMobile({
            terminalId: 'terminal-1',
            revision: 1,
            status: 'ready',
            truncated: false,
            items: [message],
            turns: [],
            requests: [],
            tasks,
        });
        expect(windowed.items).toEqual([message]);
        expect(windowed.tasks?.map(({ id }) => id)).toEqual(tasks.map(({ id }) => id));
        // Each run keeps its outline: every member with its status, none of the previews or the result.
        const listed = windowed.tasks ?? [];
        for (const value of listed) {
            expect(value.workflow?.members).toHaveLength(20);
            expect(value.workflow?.members[0]).toEqual({
                index: 0,
                label: 'review:0',
                status: 'completed',
            });
            expect(value.workflow?.result).toBeUndefined();
        }
    });

    it('keeps running workflow outlines first and drops whole runs past the budget', () => {
        const members = Array.from({ length: 200 }, (_, index) => ({
            index,
            taskId: `workflow:run-${index}:agent-${index}`,
            label: `review:security-${index}`,
            phase: 'Review',
            status: 'completed' as const,
            agentType: 'general-purpose',
        }));
        const big = (id: string, status: AgentChatTask['status'], at: number) =>
            task({
                id,
                kind: 'agent',
                status,
                startedAt: at,
                endedAt: status === 'running' ? undefined : at,
                workflow: { phases: [{ title: 'Review' }], members },
            });
        const small = task({
            id: 'small',
            kind: 'agent',
            status: 'completed',
            endedAt: 1,
            workflow: {
                phases: [],
                members: [{ index: 0, label: 'x'.repeat(200), status: 'failed' }],
                error: 'e'.repeat(5_000),
            },
        });
        const clipped = clipAgentChatTasksForMobile([
            big('ended-big', 'completed', 9),
            big('running-big', 'running', 2),
            small,
        ]);
        const outline = (id: string) => clipped.find((value) => value.id === id)?.workflow;
        // Too large in full, so the running run keeps the compact outline: exact counts, no labels.
        expect(outline('running-big')?.members).toHaveLength(200);
        expect(outline('running-big')?.members[0]).toEqual({
            index: 0,
            label: '',
            phase: 'Review',
            status: 'completed',
        });
        expect(outline('ended-big')).toBeUndefined();
        expect(outline('small')?.error?.length).toBe(MOBILE_AGENT_CHAT_WORKFLOW_ERROR_MAX_LENGTH);
        expect(outline('small')?.members[0]?.label.length).toBe(
            MOBILE_AGENT_CHAT_WORKFLOW_LABEL_MAX_LENGTH,
        );
        const total = clipped.reduce(
            (sum, value) => sum + (value.workflow ? bytes(value.workflow) : 0),
            0,
        );
        expect(total).toBeLessThanOrEqual(MOBILE_AGENT_CHAT_WORKFLOWS_MAX_BYTES);
    });
});

describe('mobile task detail', () => {
    it('keeps the tail of a shell output within its byte budget, even for wide characters', () => {
        const output = `${'head\n'.repeat(10)}${'界'.repeat(30_000)}tail`;
        const clipped = clipAgentChatTaskSnapshotForMobile({
            terminalId: 'terminal-1',
            taskId: 'task-1',
            revision: 4,
            truncated: false,
            items: [],
            output,
        });
        expect(clipped.output?.endsWith('tail')).toBe(true);
        expect(clipped.output?.startsWith(MOBILE_AGENT_CHAT_CLIP_MARKER)).toBe(true);
        expect(bytes(clipped.output)).toBeLessThanOrEqual(MOBILE_AGENT_CHAT_TASK_OUTPUT_MAX_BYTES);
        expect(agentChatTaskSnapshotSchema.safeParse(clipped).success).toBe(true);
    });

    it("keeps a subagent's newest messages in one frame and marks the rest as cut", () => {
        const items: AgentChatItem[] = Array.from({ length: 40 }, (_, index) => ({
            id: `item-${index}`,
            type: 'agentMessage',
            text: 'z'.repeat(3_000),
            streaming: false,
        }));
        const clipped = clipAgentChatTaskSnapshotForMobile({
            terminalId: 'terminal-1',
            taskId: 'task-1',
            revision: 4,
            truncated: false,
            items,
        });
        expect(bytes(clipped)).toBeLessThanOrEqual(MOBILE_AGENT_CHAT_MAX_BYTES);
        expect(clipped.truncated).toBe(true);
        expect(clipped.items.at(-1)?.id).toBe('item-39');
        const small = {
            terminalId: 'terminal-1',
            taskId: 'task-1',
            revision: 4,
            truncated: false,
            items: items.slice(0, 1),
            output: 'ok',
        };
        expect(clipAgentChatTaskSnapshotForMobile(small)).toEqual(small);
    });

    it("keeps a recorded workflow run's outline and a shortened result in its detail", () => {
        const members = Array.from({ length: 200 }, (_, index) => ({
            index,
            label: `review:${index}`,
            status: 'completed' as const,
            resultPreview: 'r'.repeat(2_000),
        }));
        const clipped = clipAgentChatTaskSnapshotForMobile({
            terminalId: 'terminal-1',
            taskId: 'workflow-1',
            revision: 1,
            truncated: false,
            items: [],
            workflow: { phases: [{ title: 'Review' }], members, result: 'w'.repeat(8_000) },
        });
        expect(bytes(clipped)).toBeLessThanOrEqual(MOBILE_AGENT_CHAT_MAX_BYTES);
        expect(clipped.workflow?.members).toHaveLength(200);
        expect(clipped.workflow?.members[0]?.resultPreview).toBeUndefined();
        expect(clipped.workflow?.result?.length).toBe(MOBILE_AGENT_CHAT_WORKFLOW_RESULT_MAX_LENGTH);
        expect(agentChatTaskSnapshotSchema.safeParse(clipped).success).toBe(true);
    });

    it("keeps a huge recorded run's detail within one frame and its members openable", () => {
        const long = (prefix: string, index: number) => `${prefix}${index}`.padEnd(120, 'x');
        const members = Array.from({ length: 200 }, (_, index) => ({
            index,
            // Claude Code's run and agent ids are short hex strings.
            taskId: `workflow:wf_8f3a2c1d:a${String(index).padStart(16, '0')}`,
            label: long('review:', index),
            phase: long('Phase ', index % 4),
            agentType: long('type', index),
            status: 'completed' as const,
        }));
        const clipped = clipAgentChatTaskSnapshotForMobile({
            terminalId: 'terminal-1',
            taskId: 'workflow-1',
            revision: 1,
            truncated: false,
            items: [],
            workflow: {
                phases: Array.from({ length: 4 }, (_, index) => ({ title: long('Phase ', index) })),
                members,
                result: '结'.repeat(8_000),
            },
        });
        expect(bytes(clipped)).toBeLessThanOrEqual(MOBILE_AGENT_CHAT_MAX_BYTES);
        expect(clipped.workflow?.members).toHaveLength(200);
        expect(clipped.workflow?.members.every((member) => member.taskId !== undefined)).toBe(true);
        expect(bytes(clipped.workflow)).toBeLessThanOrEqual(
            MOBILE_AGENT_CHAT_TASK_WORKFLOW_MAX_BYTES,
        );
        expect(agentChatTaskSnapshotSchema.safeParse(clipped).success).toBe(true);
    });

    it('reads and stops a task by its id under the Chat Terminal', () => {
        const target = { terminalId: 'terminal-1', taskId: 'task-1' };
        expect(mobileAgentChatMethods['mobile.agentChat.readTask'].params.parse(target)).toEqual(
            target,
        );
        expect(mobileAgentChatMethods['mobile.agentChat.stopTask'].params.parse(target)).toEqual(
            target,
        );
        expect(
            mobileAgentChatMethods['mobile.agentChat.stopTask'].params.safeParse({
                terminalId: 'terminal-1',
            }).success,
        ).toBe(false);
    });
});
