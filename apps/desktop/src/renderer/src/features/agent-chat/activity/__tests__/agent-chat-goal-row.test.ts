import type { AgentChatActivity } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatGoalSpend, agentChatLiveGoalActivity } from '../agent-chat-goal-row';

const working: AgentChatActivity = {
    kind: 'working',
    text: 'Mapping the terrain…',
    startedAt: undefined,
};

describe('agentChatLiveGoalActivity', () => {
    it('hands a working turn on an active goal to the goal row', () => {
        expect(agentChatLiveGoalActivity({ status: 'active' }, working, false)).toBe(working);
    });

    it('leaves the turn its own row while it stops, compacts, or the goal is not active', () => {
        expect(agentChatLiveGoalActivity({ status: 'active' }, working, true)).toBeUndefined();
        expect(
            agentChatLiveGoalActivity(
                { status: 'active' },
                { kind: 'compacting', text: 'Compacting', isStoppable: true },
                false,
            ),
        ).toBeUndefined();
        expect(agentChatLiveGoalActivity({ status: 'paused' }, working, false)).toBeUndefined();
        expect(agentChatLiveGoalActivity(undefined, working, false)).toBeUndefined();
    });
});

describe('agentChatGoalSpend', () => {
    it('shows only the figures counted for this goal', () => {
        const usage = { objective: 'ship it', requests: 3, totalTokens: 900 };
        expect(agentChatGoalSpend({ objective: 'ship it' }, usage)).toBe(usage);
        expect(agentChatGoalSpend({ objective: 'another goal' }, usage)).toBeUndefined();
        expect(agentChatGoalSpend({ objective: 'ship it' }, undefined)).toBeUndefined();
    });
});
