import type { AgentChatGoal } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatGoalBarView, agentChatRunningTurnStartedAt } from '../agent-chat-goal';

const goal = (overrides: Partial<AgentChatGoal> = {}): AgentChatGoal => ({
    objective: 'Ship the release',
    status: 'active',
    timeUsedSeconds: 60,
    tokensUsed: 0,
    updatedAt: 10_000,
    ...overrides,
});

const idle = { activeTurnId: undefined, turns: [] };

describe('agentChatGoalBarView', () => {
    it('shows nothing without a goal or for a saved copy', () => {
        expect(agentChatGoalBarView(idle, 0, false)).toBeUndefined();
        expect(agentChatGoalBarView(undefined, 0, false)).toBeUndefined();
        expect(agentChatGoalBarView({ ...idle, goal: goal() }, 0, true)).toBeUndefined();
    });

    it('words an idle active goal as Desktop and offers Pause', () => {
        expect(agentChatGoalBarView({ ...idle, goal: goal() }, 99_000, false)).toEqual({
            status: 'Pursuing goal',
            objective: 'Ship the release',
            elapsed: '1m 0s',
            isActive: true,
            isTicking: false,
            toggle: 'pause',
        });
    });

    it('adds the running turn to an active goal and keeps ticking', () => {
        const snapshot = {
            activeTurnId: 't1',
            goal: goal(),
            turns: [{ id: 't1', startedAt: 20_000 }] as never,
        };
        const view = agentChatGoalBarView(snapshot, 50_000, false);
        expect(view?.elapsed).toBe('1m 30s');
        expect(view?.isTicking).toBe(true);
        expect(agentChatRunningTurnStartedAt(snapshot)).toBe(20_000);
    });

    it('offers Resume for a paused goal and only Clear once complete', () => {
        expect(
            agentChatGoalBarView({ ...idle, goal: goal({ status: 'paused' }) }, 0, false),
        ).toMatchObject({ status: 'Goal paused', toggle: 'resume', isActive: false });
        expect(
            agentChatGoalBarView({ ...idle, goal: goal({ status: 'complete' }) }, 0, false),
        ).toMatchObject({ status: 'Goal achieved', toggle: undefined });
    });
});
