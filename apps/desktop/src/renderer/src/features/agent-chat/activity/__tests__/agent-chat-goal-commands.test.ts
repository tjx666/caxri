import { describe, expect, it, vi } from 'vitest';

const request = vi.fn();

vi.mock('../../../../stores/toasts', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    tryCommand: (_label: string, run: () => Promise<unknown>) => run(),
}));
vi.mock('../../../../lib/caxri', () => ({ caxri: { request } }));

const { agentChatGoalClearLabelKey, changeAgentChatGoal } =
    await import('../agent-chat-goal-commands');

describe('changeAgentChatGoal', () => {
    it('drops a second click while the first change is in flight, then accepts the next one', async () => {
        const pending = Promise.withResolvers<void>();
        request.mockImplementationOnce(() => pending.promise);
        const first = changeAgentChatGoal('t1', { action: 'clear' });
        await changeAgentChatGoal('t1', { action: 'clear' });
        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith('agentChat.runCommand', {
            terminalId: 't1',
            name: 'goal',
            arguments: 'clear',
        });

        pending.resolve();
        await first;
        request.mockResolvedValueOnce(undefined);
        await changeAgentChatGoal('t1', { action: 'clear' });
        expect(request).toHaveBeenCalledTimes(2);
    });
});

describe('agentChatGoalClearLabelKey', () => {
    it('names the stopped turn only for an active goal that cannot pause while a turn runs', () => {
        const active = { pausable: false, status: 'active' } as const;
        expect(agentChatGoalClearLabelKey(active, true)).toBe('agentChat.goal.clearAndStop');
        expect(agentChatGoalClearLabelKey(active, false)).toBe('agentChat.goal.clear');
        expect(agentChatGoalClearLabelKey({ status: 'active' }, true)).toBe('agentChat.goal.clear');
        // A goal Claude Code already settled no longer runs inside the turn.
        expect(agentChatGoalClearLabelKey({ pausable: false, status: 'complete' }, true)).toBe(
            'agentChat.goal.clear',
        );
        expect(agentChatGoalClearLabelKey({ pausable: false, status: 'failed' }, true)).toBe(
            'agentChat.goal.clear',
        );
    });
});
