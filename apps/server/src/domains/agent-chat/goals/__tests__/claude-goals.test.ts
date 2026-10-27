import type { AgentChatItem, AgentChatNoticeHeading } from '@caxri/protocol';
import {
    agentChatGoalToggle,
    applyAgentChatOperation,
    emptyAgentChatSnapshot,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentChatSessionHost } from '../../chat-provider';
import { ClaudeGoals } from '../claude-goals';

type Notice = Extract<AgentChatItem, { type: 'notice' }>;

function harness(activeTurnId?: string) {
    let snapshot = {
        ...emptyAgentChatSnapshot('terminal-1'),
        ...(activeTurnId && { activeTurnId }),
    };
    const host: Pick<AgentChatSessionHost, 'apply' | 'lifecycle' | 'read'> = {
        lifecycle: () => {},
        read: () => snapshot,
        apply: (operations) => {
            snapshot = operations.reduce(applyAgentChatOperation, snapshot);
        },
    };
    return { goals: new ClaudeGoals(host), read: () => snapshot };
}

const GOAL_COMMAND: AgentChatNoticeHeading = { kind: 'command', command: 'goal' };

function reply(message: string, heading: AgentChatNoticeHeading = GOAL_COMMAND): Notice {
    return { id: `notice:${message}`, type: 'notice', kind: 'output', heading, message };
}

const turn = (status: 'completed' | 'interrupted' | 'failed', id = 'turn-1') => ({
    id,
    status,
    startedAt: 1_000,
});

describe('ClaudeGoals', () => {
    it('shows a goal Claude Code set, without a Pause it cannot honor', () => {
        const { goals, read } = harness('turn-1');
        goals.onNotices([reply('Goal set: All tests pass')], 2_000);
        expect(read().goal).toEqual({
            objective: 'All tests pass',
            status: 'active',
            tokensUsed: 0,
            timeUsedSeconds: 0,
            updatedAt: 2_000,
            pausable: false,
        });
        expect(agentChatGoalToggle(read().goal!)).toBeUndefined();
    });

    it('reads the goal from the live `/goal` command frame it shows in Chat', () => {
        const { goals, read } = harness('turn-1');
        const isShown = goals.applyFeedback({
            type: 'assistant',
            uuid: 'goal',
            local_command_run: { command: 'goal', args: 'All tests pass' },
            local_command_source:
                '<local-command-stdout>Goal set: All tests pass</local-command-stdout>',
        });
        expect(isShown).toBe(true);
        expect(read().items).toHaveLength(1);
        expect(read().goal).toMatchObject({ objective: 'All tests pass', status: 'active' });
    });

    it('clears the goal once a turn completes with nothing left to wake Claude Code', () => {
        const { goals, read } = harness('turn-1');
        goals.onNotices([reply('Goal set: All tests pass')], 2_000);
        goals.onTurnEnded(turn('completed'), false, 5_000);
        expect(read().goal).toBeUndefined();
    });

    it('keeps the goal and its time while background work or an interrupt leaves it unchecked', () => {
        const { goals, read } = harness('turn-1');
        goals.onNotices([reply('Goal set: All tests pass')], 2_000);
        goals.onTurnEnded(turn('completed'), true, 5_000);
        expect(read().goal).toMatchObject({ timeUsedSeconds: 3, updatedAt: 5_000 });
        goals.onTurnEnded(turn('interrupted', 'turn-2'), false, 9_000);
        expect(read().goal).toMatchObject({ status: 'active', timeUsedSeconds: 7 });
    });

    it('keeps the goal through a turn that only printed its status', () => {
        const { goals, read } = harness('turn-1');
        goals.onNotices([reply('Goal set: Green CI')], 2_000);
        goals.onNotices([reply('Goal active: Green CI (1 turn, 3s)')], 3_000);
        expect(read().goal).toMatchObject({ updatedAt: 2_000 });
        goals.onTurnEnded(turn('completed'), false, 4_000);
        expect(read().goal).toMatchObject({
            objective: 'Green CI',
            status: 'active',
            timeUsedSeconds: 0,
            updatedAt: 2_000,
        });
    });

    it('drops the goal when it is cleared, missing, or abandoned after an error', () => {
        for (const notice of [
            reply('Goal cleared: Green CI'),
            reply('No goal set'),
            {
                id: 'warning',
                type: 'notice',
                kind: 'warning',
                heading: { kind: 'provider', provider: 'claude', topic: 'warning' },
                message:
                    'Goal cleared after an unrecoverable error (context limit): "Green CI". Run /goal again to continue.',
            } satisfies Notice,
        ]) {
            const { goals, read } = harness();
            goals.onNotices([reply('Goal set: Green CI')]);
            goals.onNotices([notice]);
            expect(read().goal).toBeUndefined();
        }
    });

    it('ignores a plugin command of the same name and other output', () => {
        const { goals, read } = harness();
        goals.onNotices([
            reply('Goal set: x', { kind: 'command', plugin: 'my-plugin', command: 'goal' }),
            reply('Renamed', { kind: 'command', command: 'rename' }),
        ]);
        expect(read().goal).toBeUndefined();
    });
});
