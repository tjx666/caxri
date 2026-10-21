import type { AgentChatActivity, AgentChatPlan, AgentChatTask } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import {
    agentChatLatestTurnStart,
    agentChatPlanBadgeLabel,
    agentChatStatusRowView,
    agentChatTaskBadgeLabel,
} from './agent-chat-status-row-view';

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

describe('agentChatStatusRowView', () => {
    it('shows no row when the Chat is idle with nothing left to act on', () => {
        expect(
            agentChatStatusRowView({
                activity: undefined,
                latestTurnStartedAt: 100,
                plan: plan('completed', 'completed'),
                seenFailureIds: NONE,
                tasks: [task('done', 'completed', 200)],
            }),
        ).toBeUndefined();
    });

    it('leads with the turn and badges the plan and running tasks while the Chat works', () => {
        const view = agentChatStatusRowView({
            activity: WORKING,
            latestTurnStartedAt: 100,
            plan: plan('completed', 'inProgress', 'pending'),
            seenFailureIds: NONE,
            tasks: [task('build', 'running', 150)],
        });
        expect(view?.lead).toEqual({ kind: 'activity', activity: WORKING });
        expect(view?.planBadge).toEqual({ completed: 1, total: 3, current: 'Step 2' });
        expect(view?.taskBadge).toEqual({ running: 1, unseenFailures: 0 });
    });

    it('keeps the badges while the turn waits on the user', () => {
        const view = agentChatStatusRowView({
            activity: { kind: 'waiting', text: 'Waiting for approval' },
            latestTurnStartedAt: 100,
            plan: plan('inProgress'),
            seenFailureIds: NONE,
            tasks: [task('build', 'running', 150)],
        });
        expect(view?.lead.kind).toBe('activity');
        expect(view?.planBadge).toBeDefined();
        expect(view?.taskBadge).toBeDefined();
    });

    it('shows no row for a waiting turn with nothing to badge', () => {
        expect(
            agentChatStatusRowView({
                activity: { kind: 'waiting', text: 'Waiting for approval' },
                latestTurnStartedAt: 100,
                plan: undefined,
                seenFailureIds: NONE,
                tasks: undefined,
            }),
        ).toBeUndefined();
    });

    it('inlines the one task still running after the turn, without a task badge', () => {
        const running = task('build', 'running', 150);
        const view = agentChatStatusRowView({
            activity: undefined,
            latestTurnStartedAt: 100,
            plan: plan('completed'),
            seenFailureIds: NONE,
            tasks: [running, task('old', 'completed', 120)],
        });
        expect(view?.lead).toEqual({ kind: 'task', task: running });
        expect(view?.taskBadge).toBeUndefined();
        // A finished plan leaves with its turn.
        expect(view?.planBadge).toBeUndefined();
        expect(view?.ended.map(({ id }) => id)).toEqual(['old']);
    });

    it('counts several running tasks and keeps an unfinished plan as a badge beside them', () => {
        const view = agentChatStatusRowView({
            activity: undefined,
            latestTurnStartedAt: 100,
            plan: plan('completed', 'pending'),
            seenFailureIds: NONE,
            tasks: [task('a', 'running', 150), task('b', 'running', 160)],
        });
        expect(view?.lead).toEqual({ kind: 'tasks', count: 2 });
        expect(view?.planBadge).toMatchObject({ completed: 1, total: 2 });
    });

    it('leads with failures from the latest turn until the user has seen them', () => {
        const input = {
            activity: undefined,
            latestTurnStartedAt: 100,
            plan: undefined,
            tasks: [task('broke', 'failed', 150), task('history', 'failed', 10)],
        };
        const view = agentChatStatusRowView({ ...input, seenFailureIds: NONE });
        expect(view?.lead).toEqual({ kind: 'failures', count: 1 });
        expect(view?.unseenFailureIds).toEqual(['broke']);
        expect(view?.failed.map(({ id }) => id)).toEqual(['broke', 'history']);
        expect(
            agentChatStatusRowView({ ...input, seenFailureIds: new Set(['broke']) }),
        ).toBeUndefined();
    });

    it('badges unseen failures while the Chat works even when nothing runs', () => {
        const view = agentChatStatusRowView({
            activity: WORKING,
            latestTurnStartedAt: 100,
            plan: undefined,
            seenFailureIds: NONE,
            tasks: [task('broke', 'failed', 150)],
        });
        expect(view?.taskBadge).toEqual({ running: 0, unseenFailures: 1 });
    });

    it('leads with a plan the turn left unfinished', () => {
        const view = agentChatStatusRowView({
            activity: undefined,
            latestTurnStartedAt: 100,
            plan: plan('completed', 'inProgress', 'pending'),
            seenFailureIds: NONE,
            tasks: undefined,
        });
        expect(view?.lead).toEqual({
            kind: 'plan',
            progress: { completed: 1, total: 3, current: 'Step 2' },
        });
        expect(view?.planBadge).toBeUndefined();
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

describe('status row badge labels', () => {
    it('names the plan step in progress when there is one', () => {
        expect(
            agentChatPlanBadgeLabel({ completed: 1, total: 3, current: 'Build' }, translate),
        ).toBe(
            translate('agentChat.plan.progressWithCurrent', {
                completed: 1,
                total: 3,
                current: 'Build',
            }),
        );
        expect(
            agentChatPlanBadgeLabel({ completed: 3, total: 3, current: undefined }, translate),
        ).toBe(translate('agentChat.plan.progress', { completed: 3, total: 3 }));
    });

    it('sums up running and unseen failed background work', () => {
        const running = translate('agentChat.tasks.runningCount', { count: 2 });
        const failed = translate('agentChat.status.tasksFailedOne');
        expect(agentChatTaskBadgeLabel({ running: 2, unseenFailures: 1 }, translate)).toBe(
            translate('agentChat.status.tasksBadge', { summary: `${running}, ${failed}` }),
        );
        expect(agentChatTaskBadgeLabel({ running: 2, unseenFailures: 0 }, translate)).toBe(
            translate('agentChat.status.tasksBadge', { summary: running }),
        );
    });
});
