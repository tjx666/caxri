import type { AgentChatActivity } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatGoalAutoExpandKey,
    agentChatGoalNoticeObjective,
    agentChatGoalSpend,
    agentChatLiveGoalActivity,
} from '../agent-chat-goal-row';

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
                { kind: 'compacting', text: 'Compacting', isStoppable: true, startedAt: undefined },
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

describe('agentChatGoalAutoExpandKey', () => {
    it('keys only unfinished goals that carry a reason', () => {
        const goal = { objective: 'Ship', reason: 'Tests fail' } as const;
        expect(agentChatGoalAutoExpandKey({ ...goal, status: 'failed' })).toBe('failed:Ship');
        expect(agentChatGoalAutoExpandKey({ ...goal, status: 'blocked' })).toBe('blocked:Ship');
        expect(agentChatGoalAutoExpandKey({ ...goal, status: 'budgetLimited' })).toBe(
            'budgetLimited:Ship',
        );
        expect(agentChatGoalAutoExpandKey({ ...goal, status: 'complete' })).toBeUndefined();
        expect(agentChatGoalAutoExpandKey({ objective: 'Ship', status: 'failed' })).toBeUndefined();
    });
});

describe('agentChatGoalNoticeObjective', () => {
    it('leaves the condition to the /goal message a set reply answers', () => {
        expect(agentChatGoalNoticeObjective({ action: 'set', objective: 'Ship it' })).toBe('');
    });

    it('keeps the condition a bare /goal or /goal clear did not show', () => {
        expect(agentChatGoalNoticeObjective({ action: 'active', objective: 'Ship it' })).toBe(
            'Ship it',
        );
        expect(agentChatGoalNoticeObjective({ action: 'cleared', objective: 'Ship it' })).toBe(
            'Ship it',
        );
    });
});
