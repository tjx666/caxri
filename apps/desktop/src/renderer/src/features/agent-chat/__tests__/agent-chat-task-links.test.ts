import type { AgentChatTask } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openers = vi.hoisted(() => ({
    openAgentChatTaskTab: vi.fn(),
    openAgentChatTurnReview: vi.fn(),
}));

vi.mock('../agent-chat-task-opener', () => openers);

const { createAgentChatTaskLinks } = await import('../hooks/use-agent-chat-task-link');

const runningShell: AgentChatTask = {
    id: 'task-1',
    itemId: 'item-1',
    kind: 'shell',
    title: 'bun run dev',
    status: 'running',
    isBackground: true,
    canStop: true,
};

describe('createAgentChatTaskLinks', () => {
    beforeEach(() => {
        openers.openAgentChatTaskTab.mockClear();
        openers.openAgentChatTurnReview.mockClear();
    });

    it('opens tasks and turn reviews beside a Workbench Chat', () => {
        const links = createAgentChatTaskLinks([runningShell], 'terminal-1', true);
        expect(links.tasksByItem.get('item-1')).toBe(runningShell);
        links.openTask?.('task-1');
        links.openTurnReview?.('turn-1');
        expect(openers.openAgentChatTaskTab).toHaveBeenCalledWith('terminal-1', 'task-1');
        expect(openers.openAgentChatTurnReview).toHaveBeenCalledWith('terminal-1', 'turn-1');
    });

    it('keeps live task status but offers no openers where the host cannot open beside Chat', () => {
        // Regression for caxri#1719: the Commander Chat lost `tasksByItem`, so running task rows folded into the
        // command summary while the task strip still showed them running.
        const links = createAgentChatTaskLinks([runningShell], 'terminal-1', false);
        expect(links.tasksByItem.get('item-1')?.status).toBe('running');
        expect(links.openTask).toBeUndefined();
        expect(links.openTurnReview).toBeUndefined();
    });
});
