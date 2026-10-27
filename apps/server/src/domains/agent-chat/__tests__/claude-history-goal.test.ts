import type { AgentChatGoal } from '@caxri/protocol';
import { agentChatGoalToggle } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { claudeHistoryOperations } from '../claude-history';

/**
 * Transcript records in the shapes Claude Code 2.1.310 writes for `/goal` (read from real session transcripts; the
 * conditions here are invented). Each record continues the previous one, as a linear conversation does.
 */
type RecordBody = Record<string, unknown>;

function transcript(bodies: RecordBody[]): string {
    return bodies
        .map((body, index) =>
            JSON.stringify({
                uuid: `r${index}`,
                parentUuid: index === 0 ? null : `r${index - 1}`,
                timestamp: new Date(Date.UTC(2026, 9, 28, 1, 0, index)).toISOString(),
                ...body,
            }),
        )
        .join('\n');
}

const goalSet = (condition: string): RecordBody => ({
    type: 'attachment',
    attachment: { type: 'goal_status', met: false, sentinel: true, condition },
});

const goalUnmet = (condition: string): RecordBody => ({
    type: 'attachment',
    attachment: { type: 'goal_status', met: false, condition, reason: 'Checks still fail.' },
});

const goalMet = (condition: string): RecordBody => ({
    type: 'attachment',
    attachment: {
        type: 'goal_status',
        met: true,
        condition,
        reason: 'All checks pass.',
        durationMs: 60_000,
        iterations: 2,
        tokens: 1_000,
    },
});

const goalReply = (stdout: string): RecordBody => ({
    type: 'system',
    subtype: 'local_command',
    isMeta: false,
    commandRun: { command: 'goal' },
    content: `<local-command-stdout>${stdout}</local-command-stdout>`,
});

const prompt = (text: string): RecordBody => ({
    type: 'user',
    message: { role: 'user', content: text },
});

const answer = (text: string): RecordBody => ({
    type: 'assistant',
    message: { id: `m-${text}`, content: [{ type: 'text', text }] },
});

const turnTook = (durationMs: number): RecordBody => ({
    type: 'system',
    subtype: 'turn_duration',
    durationMs,
});

/**
 * One turn that pursued the goal: the prompt, a reply, and how long it ran.
 */
const goalTurn = (text: string, durationMs: number): RecordBody[] => [
    prompt(text),
    answer(`Working on ${text}`),
    turnTook(durationMs),
];

const NOW = 1_800_000_000_000;

function replayedGoal(bodies: RecordBody[]): AgentChatGoal | null | undefined {
    const state = claudeHistoryOperations(transcript(bodies), false, undefined, NOW).findLast(
        (operation) => operation.op === 'state',
    );
    return state?.op === 'state' ? state.state.goal : undefined;
}

describe('Claude transcript goal replay', () => {
    it('restores a goal the transcript leaves active, with the time its turns ran and no Pause', () => {
        const goal = replayedGoal([
            prompt('Before the goal'),
            turnTook(5_000),
            goalSet('All tests pass'),
            goalReply('Goal set: All tests pass'),
            ...goalTurn('fix the parser', 90_000),
            goalUnmet('All tests pass'),
            ...goalTurn('fix the lexer', 30_400),
        ]);

        expect(goal).toEqual({
            objective: 'All tests pass',
            status: 'active',
            tokensUsed: 0,
            timeUsedSeconds: 120,
            updatedAt: NOW,
            pausable: false,
        });
        expect(agentChatGoalToggle(goal!)).toBeUndefined();
    });

    it('drops a goal that was met or failed', () => {
        expect(
            replayedGoal([
                goalSet('All tests pass'),
                ...goalTurn('fix it', 1_000),
                goalMet('All tests pass'),
            ]),
        ).toBeUndefined();
        expect(
            replayedGoal([
                goalSet('All tests pass'),
                ...goalTurn('fix it', 1_000),
                {
                    type: 'attachment',
                    attachment: {
                        type: 'goal_status',
                        met: false,
                        failed: true,
                        condition: 'All tests pass',
                        reason: 'Gave up.',
                    },
                },
            ]),
        ).toBeUndefined();
    });

    it('drops a goal the user cleared, or Claude Code cleared after an error', () => {
        expect(
            replayedGoal([
                goalSet('All tests pass'),
                ...goalTurn('fix it', 1_000),
                goalReply('Goal cleared: All tests pass'),
            ]),
        ).toBeUndefined();
        expect(
            replayedGoal([
                goalSet('All tests pass'),
                ...goalTurn('fix it', 1_000),
                {
                    type: 'system',
                    subtype: 'informational',
                    level: 'warning',
                    content: 'Goal cleared after an unrecoverable error: context window is full',
                },
            ]),
        ).toBeUndefined();
    });

    it('times a replacing goal from when it was set', () => {
        const goal = replayedGoal([
            goalSet('All tests pass'),
            ...goalTurn('first', 40_000),
            goalSet('The build is green'),
            ...goalTurn('second', 10_000),
        ]);
        expect(goal).toMatchObject({ objective: 'The build is green', timeUsedSeconds: 10 });
    });

    it('keeps the time when Claude Code repeats the set record for the same goal', () => {
        const goal = replayedGoal([
            goalSet('All tests pass'),
            ...goalTurn('first', 40_000),
            goalSet('All tests pass'),
            ...goalTurn('second', 10_000),
        ]);
        expect(goal).toMatchObject({ timeUsedSeconds: 50 });
    });

    it('ignores a subagent sidechain goal record', () => {
        expect(
            replayedGoal([
                prompt('hello'),
                { ...goalSet('Subagent goal'), isSidechain: true },
                answer('hi'),
            ]),
        ).toBeUndefined();
    });
});
