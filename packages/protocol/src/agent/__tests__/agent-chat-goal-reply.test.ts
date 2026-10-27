import { describe, expect, it } from 'vitest';

import type { AgentChatItem, AgentChatNoticeHeading } from '../agent-chat-contract.js';
import { parseAgentChatGoalReply } from '../agent-chat-goal.js';

const GOAL_COMMAND: AgentChatNoticeHeading = { kind: 'command', command: 'goal' };

function output(
    message: string,
    heading: AgentChatNoticeHeading = GOAL_COMMAND,
): Extract<AgentChatItem, { type: 'notice' }> {
    return { id: 'notice', type: 'notice', kind: 'output', heading, message };
}

describe('parseAgentChatGoalReply', () => {
    it('reads a goal Claude Code set', () => {
        expect(parseAgentChatGoalReply(output('Goal set: Fix every failing test'))).toEqual({
            action: 'set',
            objective: 'Fix every failing test',
        });
    });

    it('reads a cleared goal and the empty reply', () => {
        expect(parseAgentChatGoalReply(output('Goal cleared: Ship it'))).toEqual({
            action: 'cleared',
            objective: 'Ship it',
        });
        expect(parseAgentChatGoalReply(output('No goal set'))).toEqual({
            action: 'none',
            objective: '',
        });
    });

    it('splits an active goal into its condition and progress', () => {
        expect(
            parseAgentChatGoalReply(
                output('Goal active: Green CI (3 turns, 4m)\nLast check: two tests still fail'),
            ),
        ).toEqual({
            action: 'active',
            objective: 'Green CI',
            detail: '3 turns, 4m\nLast check: two tests still fail',
        });
    });

    it('keeps other replies and other commands as plain output', () => {
        expect(
            parseAgentChatGoalReply(output('No goal set. Usage: `/goal <condition>`')),
        ).toBeUndefined();
        expect(
            parseAgentChatGoalReply(
                output('Goal set: x', { kind: 'command', plugin: 'my-plugin', command: 'goal' }),
            ),
        ).toBeUndefined();
        expect(
            parseAgentChatGoalReply(output('Goal set: x', { kind: 'command', command: 'rename' })),
        ).toBeUndefined();
    });
});
