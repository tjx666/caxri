import type { AgentChatTask, AgentDelegationSession } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatBackgroundItems,
    agentChatBackgroundRows,
    delegatedBackgroundItemId,
    delegatedBackgroundState,
    splitAgentChatBackgroundItems,
} from '../agent-chat-background-items';

function entry(
    sessionId: string,
    overrides: Partial<AgentDelegationSession> = {},
): AgentDelegationSession {
    return {
        createdBySessionId: 'parent',
        relation: 'delegated',
        sessionId,
        status: 'running',
        ...overrides,
    };
}

function task(
    id: string,
    status: AgentChatTask['status'],
    overrides: Partial<AgentChatTask> = {},
): AgentChatTask {
    return {
        id,
        kind: 'agent',
        title: id,
        status,
        isBackground: true,
        canStop: true,
        startedAt: 100,
        ...overrides,
    };
}

const shell = (id: string, status: AgentChatTask['status'] = 'running') =>
    task(id, status, { kind: 'shell' });
const workflow = (id: string, status: AgentChatTask['status'] = 'running') =>
    task(id, status, { workflow: { phases: [] } as unknown as AgentChatTask['workflow'] });

const NONE = new Set<string>();
const ids = (items: ReadonlyArray<{ id: string }>) => items.map(({ id }) => id);

describe('delegatedBackgroundState', () => {
    it('asks for the user on a question, a failure, or an interruption', () => {
        expect(
            delegatedBackgroundState(
                entry('a', { failure: 'permission_required', status: 'blocked' }),
            ),
        ).toBe('attention');
        expect(
            delegatedBackgroundState(entry('a', { failure: 'provider_failed', status: 'failed' })),
        ).toBe('attention');
        expect(
            delegatedBackgroundState(entry('a', { failure: 'host_reset', status: 'failed' })),
        ).toBe('attention');
        expect(delegatedBackgroundState(entry('a', { status: 'interrupted' }))).toBe('attention');
    });

    it('keeps working tasks and drops settled ones', () => {
        expect(delegatedBackgroundState(entry('a', { status: 'launching' }))).toBe('live');
        expect(delegatedBackgroundState(entry('a', { status: 'collecting' }))).toBe('live');
        expect(delegatedBackgroundState(entry('a', { status: 'completed' }))).toBeUndefined();
        expect(
            delegatedBackgroundState(entry('a', { status: 'human_intervened' })),
        ).toBeUndefined();
        expect(
            delegatedBackgroundState(entry('a', { status: 'answer_unavailable' })),
        ).toBeUndefined();
        expect(
            delegatedBackgroundState(entry('a', { failure: 'caller_stopped', status: 'failed' })),
        ).toBeUndefined();
    });
});

describe('agentChatBackgroundItems', () => {
    it('lists rows that need the user first across kinds, then groups the rest as delegated, workflow, subagent, shell', () => {
        const items = agentChatBackgroundItems({
            delegated: [
                entry('running-child'),
                entry('asking-child', { failure: 'permission_required', status: 'blocked' }),
            ],
            dismissedIds: NONE,
            work: {
                failed: [shell('broken-shell', 'failed')],
                running: [shell('build'), task('reviewer', 'running'), workflow('verify')],
            },
        });
        expect(ids(items)).toEqual([
            'delegation:asking-child',
            'broken-shell',
            'delegation:running-child',
            'verify',
            'reviewer',
            'build',
        ]);
        expect(items.map(({ requiresUser }) => requiresUser)).toEqual([
            true,
            true,
            false,
            false,
            false,
            false,
        ]);
    });

    it('drops a dismissed delegated failure but never a question waiting on the user', () => {
        const failed = entry('failed-child', { failure: 'provider_failed', status: 'failed' });
        const asking = entry('asking-child', { failure: 'permission_required', status: 'blocked' });
        const items = agentChatBackgroundItems({
            delegated: [failed, asking, entry('done', { status: 'completed' })],
            dismissedIds: new Set([
                delegatedBackgroundItemId(failed),
                delegatedBackgroundItemId(asking),
            ]),
            work: undefined,
        });
        expect(ids(items)).toEqual(['delegation:asking-child']);
    });

    it('keys a delegated row by its delegation so a retry in the same Session surfaces again', () => {
        expect(delegatedBackgroundItemId({ delegationId: 'd2', sessionId: 's' })).toBe(
            'delegation:d2',
        );
        expect(delegatedBackgroundItemId({ sessionId: 's' })).toBe('delegation:s');
    });
});

describe('splitAgentChatBackgroundItems', () => {
    const OPENED_AT = 1000;
    const items = agentChatBackgroundItems({
        delegated: [
            entry('running-child'),
            entry('failed-earlier', {
                failure: 'provider_failed',
                settledAt: 10,
                status: 'failed',
            }),
            entry('cut-earlier', {
                failure: 'target_changed',
                settledAt: 10,
                status: 'interrupted',
            }),
            entry('reset-earlier', { failure: 'host_reset', settledAt: 20, status: 'failed' }),
            entry('cut-now', { failure: 'target_changed', settledAt: 2000, status: 'interrupted' }),
            entry('cut-undated', { status: 'interrupted' }),
        ],
        dismissedIds: NONE,
        work: { failed: [shell('broken', 'failed')], running: [shell('build')] },
    });

    it('moves interruptions that settled before the window opened out of the rows and counts the rest', () => {
        const { current, earlier, needsYouCount, runningCount } = splitAgentChatBackgroundItems(
            items,
            OPENED_AT,
        );
        expect(ids(earlier)).toEqual(['delegation:cut-earlier', 'delegation:reset-earlier']);
        // A real failure keeps its row (and its retry actions) however old it is; an undated interruption counts as now.
        expect(ids(current)).toEqual([
            'delegation:failed-earlier',
            'delegation:cut-now',
            'delegation:cut-undated',
            'broken',
            'delegation:running-child',
            'build',
        ]);
        expect({ needsYouCount, runningCount }).toEqual({ needsYouCount: 4, runningCount: 2 });
    });

    it('shows the earlier rows on request between the rows that need the user and the running work', () => {
        const { current, earlier } = splitAgentChatBackgroundItems(items, OPENED_AT);
        expect(agentChatBackgroundRows(current, earlier, false)).toEqual(current);
        const shown = ids(agentChatBackgroundRows(current, earlier, true));
        expect(shown.slice(4, 6)).toEqual(['delegation:cut-earlier', 'delegation:reset-earlier']);
        expect(shown.slice(6)).toEqual(['delegation:running-child', 'build']);
    });
});
