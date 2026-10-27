import type { AgentChatActivity, AgentChatPlan, AgentChatTask } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../../../i18n';
import {
    agentChatBackgroundWork,
    agentChatBackgroundWorkCounts,
    agentChatBackgroundWorkSoleTask,
    agentChatLatestTurnStart,
    agentChatPlanProgressLabel,
    agentChatPlanSection,
    agentChatRunningKinds,
} from '../agent-chat-strip-sections';

const WORKING: AgentChatActivity = { kind: 'working', text: 'Working…', startedAt: 100 };

function task(id: string, status: AgentChatTask['status'], at: number): AgentChatTask {
    return {
        id,
        kind: 'shell',
        title: id,
        status,
        isBackground: true,
        canStop: true,
        startedAt: at,
        ...(status !== 'running' && { endedAt: at + 10 }),
    };
}

function plan(...statuses: Array<AgentChatPlan['steps'][number]['status']>): AgentChatPlan {
    return {
        turnId: 'turn',
        steps: statuses.map((status, index) => ({ step: `Step ${index + 1}`, status })),
    };
}

const NONE = new Set<string>();

describe('agentChatBackgroundWork', () => {
    it('shows nothing once every task ended without an unseen failure', () => {
        expect(
            agentChatBackgroundWork({
                latestTurnStartedAt: 100,
                seenFailureIds: NONE,
                tasks: [task('done', 'completed', 200), task('stopped', 'stopped', 210)],
            }),
        ).toBeUndefined();
        expect(
            agentChatBackgroundWork({
                latestTurnStartedAt: undefined,
                seenFailureIds: NONE,
                tasks: undefined,
            }),
        ).toBeUndefined();
    });

    it('lists running tasks in start order and ended ones most recent first', () => {
        const work = agentChatBackgroundWork({
            latestTurnStartedAt: 100,
            seenFailureIds: NONE,
            tasks: [
                task('second', 'running', 160),
                task('old', 'completed', 120),
                task('first', 'running', 150),
                task('newer', 'stopped', 130),
            ],
        });
        expect(work?.running.map(({ id }) => id)).toEqual(['first', 'second']);
        expect(work?.ended.map(({ id }) => id)).toEqual(['newer', 'old']);
        expect(work?.failed).toEqual([]);
    });

    it('keeps the latest turn failures up after the last task ended, until the user dismisses them', () => {
        const input = {
            latestTurnStartedAt: 100,
            tasks: [task('broke', 'failed', 150), task('history', 'failed', 10)],
        };
        const work = agentChatBackgroundWork({ ...input, seenFailureIds: NONE });
        expect(work?.failed.map(({ id }) => id)).toEqual(['broke']);
        // An older failure is history the conversation already reported: it sits under the ended tasks.
        expect(work?.ended.map(({ id }) => id)).toEqual(['history']);
        expect(
            agentChatBackgroundWork({ ...input, seenFailureIds: new Set(['broke']) }),
        ).toBeUndefined();
    });

    it('files a dismissed failure under the ended tasks while others still run', () => {
        const work = agentChatBackgroundWork({
            latestTurnStartedAt: 100,
            seenFailureIds: new Set(['broke']),
            tasks: [task('broke', 'failed', 150), task('build', 'running', 160)],
        });
        expect(work?.failed).toEqual([]);
        expect(work?.ended.map(({ id }) => id)).toEqual(['broke']);
    });
});

describe('agentChatPlanSection', () => {
    it('shows the plan while the Chat is busy, finished or not', () => {
        const finished = plan('completed', 'completed');
        expect(agentChatPlanSection({ activity: WORKING, plan: finished })).toEqual({
            plan: finished,
            progress: { completed: 2, total: 2, current: undefined },
        });
        expect(
            agentChatPlanSection({
                activity: { kind: 'waiting', text: 'Waiting for approval' },
                plan: plan('inProgress'),
            })?.progress,
        ).toEqual({ completed: 0, total: 1, current: 'Step 1' });
    });

    it('keeps an unfinished plan after the turn and lets a finished one leave with it', () => {
        expect(
            agentChatPlanSection({
                activity: undefined,
                plan: plan('completed', 'inProgress', 'pending'),
            })?.progress,
        ).toEqual({ completed: 1, total: 3, current: 'Step 2' });
        expect(
            agentChatPlanSection({ activity: undefined, plan: plan('completed') }),
        ).toBeUndefined();
    });

    it('shows nothing without steps', () => {
        expect(agentChatPlanSection({ activity: WORKING, plan: plan() })).toBeUndefined();
        expect(agentChatPlanSection({ activity: WORKING, plan: undefined })).toBeUndefined();
    });
});

describe('agentChatLatestTurnStart', () => {
    it('reads the start of the newest turn', () => {
        expect(
            agentChatLatestTurnStart({
                turns: [
                    { id: 'a', status: 'completed', startedAt: 1 },
                    { id: 'b', status: 'running', startedAt: 5 },
                ],
            }),
        ).toBe(5);
        expect(agentChatLatestTurnStart(undefined)).toBeUndefined();
    });
});

describe('strip section labels', () => {
    it('names the plan step in progress when there is one', () => {
        expect(
            agentChatPlanProgressLabel({ completed: 1, total: 3, current: 'Build' }, translate),
        ).toBe(
            translate('agentChat.plan.progressWithCurrent', {
                completed: 1,
                total: 3,
                current: 'Build',
            }),
        );
        expect(
            agentChatPlanProgressLabel({ completed: 3, total: 3, current: undefined }, translate),
        ).toBe(translate('agentChat.plan.progress', { completed: 3, total: 3 }));
    });

    it('counts running and failed work, leaving out a zero', () => {
        const running = task('build', 'running', 150);
        const failed = task('broke', 'failed', 160);
        const counts = (work: Parameters<typeof agentChatBackgroundWorkCounts>[0]) =>
            agentChatBackgroundWorkCounts(work, translate);
        expect(
            counts({ running: [running], runningKinds: [], failed: [failed], ended: [] }),
        ).toEqual([
            translate('agentChat.tasks.runningCount', { count: 1 }),
            translate('agentChat.tasks.failedCount', { count: 1 }),
        ]);
        expect(counts({ running: [], runningKinds: [], failed: [failed], ended: [] })).toEqual([
            translate('agentChat.tasks.failedCount', { count: 1 }),
        ]);
    });
});

describe('agentChatRunningKinds', () => {
    it('counts each running kind, subagents before shells, so neither hides the other', () => {
        const shell = task('shell', 'running', 100);
        const agent: AgentChatTask = { ...task('agent', 'running', 200), kind: 'agent' };
        expect(agentChatRunningKinds([shell, agent, task('shell-2', 'running', 300)])).toEqual([
            { kind: 'agent', count: 1 },
            { kind: 'shell', count: 2 },
        ]);
        expect(agentChatRunningKinds([shell])).toEqual([{ kind: 'shell', count: 1 }]);
        expect(agentChatRunningKinds([])).toEqual([]);
    });
});

describe('agentChatBackgroundWorkSoleTask', () => {
    function soleTask(tasks: AgentChatTask[]): AgentChatTask | undefined {
        const work = agentChatBackgroundWork({
            latestTurnStartedAt: 100,
            seenFailureIds: NONE,
            tasks,
        });
        return work && agentChatBackgroundWorkSoleTask(work);
    }

    it('returns the only running task, whatever ended before it', () => {
        const sole = task('sole', 'running', 300);
        expect(soleTask([task('done', 'completed', 200), sole])).toBe(sole);
    });

    it('keeps the header while several tasks run or a failure waits', () => {
        const running = [task('a', 'running', 300), task('b', 'running', 310)];
        const failed = task('failed', 'failed', 200);
        expect(soleTask(running)).toBeUndefined();
        expect(soleTask([running[0], failed])).toBeUndefined();
        expect(soleTask([failed])).toBeUndefined();
    });
});
