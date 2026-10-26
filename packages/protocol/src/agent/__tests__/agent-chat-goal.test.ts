import { describe, expect, it } from 'vitest';

import {
    agentChatGoalArguments,
    agentChatGoalElapsedSeconds,
    agentChatGoalToggle,
    formatAgentChatGoalDuration,
    parseAgentChatGoalArguments,
} from '../agent-chat-goal.js';
import type { AgentChatGoal } from '../agent-chat-goal-contract.js';
import { applyAgentChatOperation, emptyAgentChatSnapshot } from '../agent-chat-reducer.js';

const goal: AgentChatGoal = {
    objective: 'Ship it',
    status: 'active',
    tokensUsed: 10,
    timeUsedSeconds: 60,
    updatedAt: 1_000_000,
};

describe('Agent Chat goals', () => {
    it('reads /goal arguments as the Codex CLI does', () => {
        expect(parseAgentChatGoalArguments(undefined)).toBeUndefined();
        expect(parseAgentChatGoalArguments(' '.repeat(3))).toBeUndefined();
        expect(parseAgentChatGoalArguments(' Pause ')).toEqual({ action: 'pause' });
        expect(parseAgentChatGoalArguments('resume')).toEqual({ action: 'resume' });
        expect(parseAgentChatGoalArguments('clear')).toEqual({ action: 'clear' });
        expect(parseAgentChatGoalArguments('pause the build when it fails')).toEqual({
            action: 'set',
            objective: 'pause the build when it fails',
        });
        expect(agentChatGoalArguments({ action: 'set', objective: 'Ship it' })).toBe('Ship it');
        expect(agentChatGoalArguments({ action: 'pause' })).toBe('pause');
    });

    it('offers pause or resume by status', () => {
        expect(agentChatGoalToggle(goal)).toBe('pause');
        for (const status of ['paused', 'blocked', 'usageLimited'] as const)
            expect(agentChatGoalToggle({ ...goal, status })).toBe('resume');
        for (const status of ['budgetLimited', 'complete'] as const)
            expect(agentChatGoalToggle({ ...goal, status })).toBeUndefined();
    });

    it('offers neither for a provider that cannot pause', () => {
        expect(agentChatGoalToggle({ ...goal, pausable: false })).toBeUndefined();
    });

    it('adds the running turn to the reported time only while the goal is active', () => {
        expect(agentChatGoalElapsedSeconds(goal, 1_010_000, undefined)).toBe(60);
        // Counts from the later of the turn's start and the last report.
        expect(agentChatGoalElapsedSeconds(goal, 1_010_000, 990_000)).toBe(70);
        expect(agentChatGoalElapsedSeconds(goal, 1_010_000, 1_005_000)).toBe(65);
        expect(agentChatGoalElapsedSeconds({ ...goal, status: 'paused' }, 1_010_000, 990_000)).toBe(
            60,
        );
    });

    it('spells out hours for a long-running goal', () => {
        expect(formatAgentChatGoalDuration(0)).toBe('0s');
        expect(formatAgentChatGoalDuration(45.9)).toBe('45s');
        expect(formatAgentChatGoalDuration(725)).toBe('12m 5s');
        expect(formatAgentChatGoalDuration(5849)).toBe('1h 37m 29s');
    });

    it('sets and clears the snapshot goal through a state patch', () => {
        const set = applyAgentChatOperation(emptyAgentChatSnapshot('terminal-1'), {
            op: 'state',
            state: { goal },
        });
        expect(set.goal).toEqual(goal);
        const cleared = applyAgentChatOperation(set, { op: 'state', state: { goal: null } });
        expect('goal' in cleared).toBe(false);
    });
});
