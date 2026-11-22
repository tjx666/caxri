import type { AgentChatActivity, AgentChatPlan, AgentChatTask } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../../../i18n';
import {
    agentChatBackgroundWork,
    agentChatBackgroundWorkCounts,
    agentChatLatestTurnStart,
    agentChatPlanProgressLabel,
    agentChatPlanSection,
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

    it('lists running tasks in start order and leaves ended ones out', () => {
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
        expect(work?.failed).toEqual([]);
    });

    it('keeps the latest turn failures up after the last task ended, until the user dismisses them', () => {
        const input = {
            latestTurnStartedAt: 100,
            tasks: [task('broke', 'failed', 150), task('history', 'failed', 10)],
        };
        const work = agentChatBackgroundWork({ ...input, seenFailureIds: NONE });
        expect(work?.failed.map(({ id }) => id)).toEqual(['broke']);
        expect(
            agentChatBackgroundWork({ ...input, seenFailureIds: new Set(['broke']) }),
        ).toBeUndefined();
    });

    it('drops a dismissed failure while others still run', () => {
        const work = agentChatBackgroundWork({
            latestTurnStartedAt: 100,
            seenFailureIds: new Set(['broke']),
            tasks: [task('broke', 'failed', 150), task('build', 'running', 160)],
        });
        expect(work?.failed).toEqual([]);
        expect(work?.running.map(({ id }) => id)).toEqual(['build']);
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
        expect(counts({ running: [running], failed: [failed] })).toEqual([
            translate('agentChat.tasks.runningCount', { count: 1 }),
            translate('agentChat.tasks.failedCount', { count: 1 }),
        ]);
        expect(counts({ running: [], failed: [failed] })).toEqual([
            translate('agentChat.tasks.failedCount', { count: 1 }),
        ]);
    });
});
