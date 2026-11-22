import type { AgentChatTask, AgentDelegationSession } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatBackgroundItems,
    delegatedBackgroundItemId,
    delegatedBackgroundState,
    foldAgentChatBackgroundItems,
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

describe('foldAgentChatBackgroundItems', () => {
    const items = agentChatBackgroundItems({
        delegated: [entry('child')],
        dismissedIds: NONE,
        work: {
            failed: [shell('broken', 'failed')],
            running: [
                workflow('verify'),
                task('reviewer', 'running'),
                shell('build'),
                shell('lint'),
            ],
        },
    });

    it('keeps every row that needs the user and fills the rest of three in display order', () => {
        const { hiddenCount, shown } = foldAgentChatBackgroundItems(items);
        expect(ids(shown)).toEqual(['broken', 'delegation:child', 'verify']);
        expect(hiddenCount).toBe(3);
    });

    it('keeps the folded rows in display order, so unfolding only inserts rows between them', () => {
        const { shown } = foldAgentChatBackgroundItems(items);
        const positions = shown.map((item) => items.indexOf(item));
        expect(positions).toEqual(positions.toSorted((left, right) => left - right));
    });

    it('shows past three when more rows need the user, and hides nothing for a short list', () => {
        const attention = agentChatBackgroundItems({
            delegated: [],
            dismissedIds: NONE,
            work: {
                failed: ['a', 'b', 'c', 'd'].map((id) => shell(id, 'failed')),
                running: [shell('build')],
            },
        });
        expect(foldAgentChatBackgroundItems(attention)).toMatchObject({ hiddenCount: 1 });
        expect(ids(foldAgentChatBackgroundItems(attention).shown)).toEqual(['a', 'b', 'c', 'd']);
        expect(foldAgentChatBackgroundItems(items.slice(0, 3)).hiddenCount).toBe(0);
    });
});
