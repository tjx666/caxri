import type { AgentChatItem, AgentChatNoticeHeading } from '@caxri/protocol';
import {
    agentChatGoalToggle,
    applyAgentChatOperation,
    emptyAgentChatSnapshot,
} from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AgentChatSessionHost } from '../../chat-provider';
import { ClaudeGoals, isClaudeGoalClearDuringTurn } from '../claude-goals';

type Notice = Extract<AgentChatItem, { type: 'notice' }>;

function harness(activeTurnId?: string, transcript: () => string | undefined = () => {}) {
    let snapshot = {
        ...emptyAgentChatSnapshot('terminal-1'),
        ...(activeTurnId && { activeTurnId }),
    };
    let reads = 0;
    const host: Pick<AgentChatSessionHost, 'apply' | 'lifecycle' | 'read' | 'readTranscript'> = {
        lifecycle: () => {},
        read: () => snapshot,
        apply: (operations) => {
            snapshot = operations.reduce(applyAgentChatOperation, snapshot);
        },
        readTranscript: () => {
            reads++;
            const content = transcript();
            return Promise.resolve(
                content === undefined ? undefined : { content, truncated: false },
            );
        },
    };
    return { goals: new ClaudeGoals(host, 0), read: () => snapshot, reads: () => reads };
}

/**
 * A main-thread `goal_status` record as Claude Code 2.1.312 writes it.
 */
function goalStatus(at: number, attachment: Record<string, unknown>): string {
    return JSON.stringify({
        type: 'attachment',
        isSidechain: false,
        timestamp: new Date(at).toISOString(),
        attachment: { type: 'goal_status', condition: 'Green CI', ...attachment },
    });
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

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

    it('clears a goal that ended without a readable outcome once a turn completes', async () => {
        const { goals, read, reads } = harness('turn-1');
        goals.onNotices([reply('Goal set: All tests pass')], 2_000);
        goals.onTurnEnded(turn('completed'), false, 5_000);
        await vi.waitFor(() => expect(read().goal).toBeUndefined());
        expect(reads()).toBe(3);
    });

    it('keeps an achieved goal with its reason, time, and tokens from the transcript', async () => {
        const transcript = [
            goalStatus(500, { met: false, sentinel: true }),
            goalStatus(3_000, { met: false, reason: 'CI still red' }),
            goalStatus(4_000, {
                met: true,
                reason: 'All checks passed',
                iterations: 2,
                durationMs: 61_400,
                tokens: 1_234,
            }),
            JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' }),
        ].join('\n');
        const { goals, read } = harness('turn-1', () => transcript);
        goals.onNotices([reply('Goal set: Green CI')], 2_000);
        goals.onTurnEnded(turn('completed'), false, 5_000);
        await vi.waitFor(() => expect(read().goal?.status).toBe('complete'));
        expect(read().goal).toEqual({
            objective: 'Green CI',
            status: 'complete',
            reason: 'All checks passed',
            tokensUsed: 1_234,
            timeUsedSeconds: 61,
            updatedAt: 5_000,
            pausable: false,
        });
        // An ended goal stays as it is through later turns.
        goals.onTurnEnded(turn('completed', 'turn-2'), false, 9_000);
        await settled();
        expect(read().goal).toMatchObject({ status: 'complete', updatedAt: 5_000 });
    });

    it('marks a goal Claude Code judged impossible as failed', async () => {
        const transcript = goalStatus(4_000, {
            met: false,
            failed: true,
            reason: 'Deadline passed',
        });
        const { goals, read } = harness('turn-1', () => transcript);
        goals.onNotices([reply('Goal set: Green CI')], 2_000);
        goals.onTurnEnded(turn('completed'), false, 5_000);
        await vi.waitFor(() => expect(read().goal?.status).toBe('failed'));
        expect(read().goal).toMatchObject({ reason: 'Deadline passed', timeUsedSeconds: 3 });
    });

    it('waits for an outcome Claude Code appends after the turn ends', async () => {
        let transcript = goalStatus(500, { met: false, sentinel: true });
        const { goals, read, reads } = harness('turn-1', () => {
            const current = transcript;
            transcript = goalStatus(4_000, { met: true });
            return current;
        });
        goals.onNotices([reply('Goal set: Green CI')], 2_000);
        goals.onTurnEnded(turn('completed'), false, 5_000);
        await vi.waitFor(() => expect(read().goal?.status).toBe('complete'));
        expect(reads()).toBe(2);
    });

    it('ignores an outcome older than the turn and leaves a goal replaced meanwhile', async () => {
        const stale = harness('turn-1', () => goalStatus(500, { met: true }));
        stale.goals.onNotices([reply('Goal set: Green CI')], 2_000);
        stale.goals.onTurnEnded(turn('completed'), false, 5_000);
        await vi.waitFor(() => expect(stale.read().goal).toBeUndefined());

        const replaced = harness('turn-1', () => goalStatus(4_000, { met: true }));
        replaced.goals.onNotices([reply('Goal set: Green CI')], 2_000);
        replaced.goals.onTurnEnded(turn('completed'), false, 5_000);
        replaced.goals.onNotices([reply('Goal set: Ship it')], 5_500);
        await settled();
        expect(replaced.read().goal).toMatchObject({ objective: 'Ship it', status: 'active' });
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

    it('stops the running turn for a clear only while the goal is still pursued', async () => {
        const { goals, read } = harness('turn-1', () => goalStatus(4_000, { met: true }));
        goals.onNotices([reply('Goal set: Green CI')], 2_000);
        expect(isClaudeGoalClearDuringTurn(read(), 'goal', 'clear')).toBe(true);
        goals.onTurnEnded(turn('completed'), false, 5_000);
        await vi.waitFor(() => expect(read().goal?.status).toBe('complete'));
        expect(isClaudeGoalClearDuringTurn(read(), 'goal', 'clear')).toBe(false);
    });
});
