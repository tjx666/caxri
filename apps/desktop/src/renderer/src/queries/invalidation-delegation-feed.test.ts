import type {
    AgentDelegationSession,
    BootstrapState,
    MethodResult,
    ServerEvent,
} from '@caxri/protocol';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const state: { handler?: (event: ServerEvent) => void } = {};
    return {
        state,
        onEvent: vi.fn((handler: (event: ServerEvent) => void) => {
            state.handler = handler;
            return () => {};
        }),
    };
});

vi.mock('../lib/caxri', () => ({ caxri: mocks }));

import { useWorkbenchStore } from '../stores/workbench';
import { caxriQueryKey } from './client';
import { subscribeRuntimeQueryInvalidation } from './invalidation';
import {
    applyDelegationProgress,
    createDelegationFeedInvalidation,
} from './invalidation-delegation-feed';

type Feed = MethodResult<'agent.delegation.sessions'>;

function entry(
    sessionId: string,
    createdBySessionId: string,
    overrides: Partial<AgentDelegationSession> = {},
): AgentDelegationSession {
    return { createdBySessionId, relation: 'delegated', sessionId, ...overrides };
}

function feedKey(createdBySessionIds: string[]) {
    return caxriQueryKey('agent.delegation.sessions', { createdBySessionIds });
}

const sessions = [
    { createdBySessionId: undefined, id: 'host-a' },
    { createdBySessionId: undefined, id: 'host-b' },
    { createdBySessionId: 'host-a', id: 'child-a' },
    { createdBySessionId: 'host-b', id: 'child-b' },
];

describe('createDelegationFeedInvalidation', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function setup() {
        const client = new QueryClient();
        const keyA = feedKey(['host-a']);
        const keyB = feedKey(['host-b']);
        client.setQueryData(keyA, { sessions: [] } satisfies Feed);
        client.setQueryData(keyB, { sessions: [] } satisfies Feed);
        const isInvalidated = () =>
            [keyA, keyB].map((key) => client.getQueryState(key)?.isInvalidated);
        return { client, isInvalidated };
    }

    it('refreshes only the feed read that covers the creator of the changed Session', () => {
        const { client, isInvalidated } = setup();
        const invalidation = createDelegationFeedInvalidation(client, () => sessions);
        invalidation.invalidate(['child-a']);
        // Nothing happens before the coalescing window closes.
        expect(isInvalidated()).toEqual([false, false]);
        vi.advanceTimersByTime(1600);
        expect(isInvalidated()).toEqual([true, false]);
        invalidation.dispose();
    });

    it('does nothing for a known Session that was not created by another Session', () => {
        const { client, isInvalidated } = setup();
        const invalidation = createDelegationFeedInvalidation(client, () => sessions);
        invalidation.invalidate(['host-a', 'host-b']);
        vi.advanceTimersByTime(1600);
        expect(isInvalidated()).toEqual([false, false]);
        invalidation.dispose();
    });

    it('refreshes every feed read for a Session the records do not hold yet', () => {
        const { client, isInvalidated } = setup();
        const invalidation = createDelegationFeedInvalidation(client, () => sessions);
        invalidation.invalidate(['brand-new']);
        vi.advanceTimersByTime(1600);
        expect(isInvalidated()).toEqual([true, true]);
        invalidation.dispose();
    });

    it('coalesces a burst of pushes into one pass over everything they named', () => {
        const { client, isInvalidated } = setup();
        const readSessions = vi.fn(() => sessions);
        const invalidation = createDelegationFeedInvalidation(client, readSessions);
        invalidation.invalidate(['child-a']);
        vi.advanceTimersByTime(500);
        invalidation.invalidate(['child-b']);
        invalidation.invalidate(['child-a']);
        vi.advanceTimersByTime(1600);
        expect(readSessions).toHaveBeenCalledTimes(1);
        expect(isInvalidated()).toEqual([true, true]);
        invalidation.dispose();
    });

    it('reads the records when the window closes, not when the push arrives', () => {
        const { client, isInvalidated } = setup();
        let records = sessions.filter((session) => session.id !== 'child-b');
        const invalidation = createDelegationFeedInvalidation(client, () => records);
        invalidation.invalidate(['child-b']);
        records = sessions;
        vi.advanceTimersByTime(1600);
        // `child-b` was in the records by then, so only its creator's read refreshes.
        expect(isInvalidated()).toEqual([false, true]);
        invalidation.dispose();
    });

    it('skips the lookup entirely while no feed read is cached', () => {
        const client = new QueryClient();
        const readSessions = vi.fn(() => sessions);
        const invalidation = createDelegationFeedInvalidation(client, readSessions);
        invalidation.invalidate(['child-a']);
        vi.advanceTimersByTime(1600);
        expect(readSessions).toHaveBeenCalledTimes(1);
        expect(client.getQueryCache().getAll()).toEqual([]);
        invalidation.dispose();
    });

    it('starts a fresh window after a pass and ignores an empty push', () => {
        const { client, isInvalidated } = setup();
        const invalidation = createDelegationFeedInvalidation(client, () => sessions);
        invalidation.invalidate([]);
        vi.advanceTimersByTime(1600);
        expect(isInvalidated()).toEqual([false, false]);
        invalidation.invalidate(['child-a']);
        vi.advanceTimersByTime(1600);
        expect(isInvalidated()).toEqual([true, false]);
        invalidation.dispose();
    });

    it('drops what is pending when disposed', () => {
        const { client, isInvalidated } = setup();
        const invalidation = createDelegationFeedInvalidation(client, () => sessions);
        invalidation.invalidate(['brand-new']);
        invalidation.dispose();
        vi.advanceTimersByTime(1600);
        expect(isInvalidated()).toEqual([false, false]);
    });
});

describe('task-state reads', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const statusesKey = (delegationIds: string[]) =>
        caxriQueryKey('agent.delegation.statuses', { delegationIds });
    const status = (sessionId: string) => ({
        delegationId: `task-${sessionId}`,
        provider: 'claude' as const,
        sessionId,
        status: 'running' as const,
    });

    function setup() {
        const client = new QueryClient();
        const keyA = statusesKey(['task-child-a']);
        const keyB = statusesKey(['task-child-b']);
        client.setQueryData(keyA, { statuses: [status('child-a')] });
        client.setQueryData(keyB, { statuses: [status('child-b')] });
        return {
            client,
            isInvalidated: () =>
                [keyA, keyB].map((key) => client.getQueryState(key)?.isInvalidated),
        };
    }

    it('refreshes only the reads that name a task in the changed Session', () => {
        const { client, isInvalidated } = setup();
        const invalidation = createDelegationFeedInvalidation(client, () => sessions);
        invalidation.invalidate(['child-b']);
        vi.advanceTimersByTime(1600);
        expect(isInvalidated()).toEqual([false, true]);
        invalidation.dispose();
    });

    it('refreshes every read for a Session the records do not hold yet', () => {
        const { client, isInvalidated } = setup();
        const invalidation = createDelegationFeedInvalidation(client, () => sessions);
        invalidation.invalidate(['brand-new']);
        vi.advanceTimersByTime(1600);
        expect(isInvalidated()).toEqual([true, true]);
        invalidation.dispose();
    });

    it('leaves the reads alone for a push about a Session that has no task in them', () => {
        const { client, isInvalidated } = setup();
        const invalidation = createDelegationFeedInvalidation(client, () => sessions);
        invalidation.invalidate(['host-a']);
        vi.advanceTimersByTime(1600);
        expect(isInvalidated()).toEqual([false, false]);
        invalidation.dispose();
    });
});

describe('applyDelegationProgress', () => {
    function setup(feed: Feed) {
        const client = new QueryClient();
        const key = feedKey(['host-a']);
        client.setQueryData(key, feed);
        return { client, read: () => client.getQueryData<Feed>(key) };
    }

    it('writes the reported step into the matching entry without a refetch', () => {
        const { client, read } = setup({
            sessions: [
                entry('child-a', 'host-a', { delegationId: 'task-1', status: 'running' }),
                entry('child-b', 'host-a', { delegationId: 'task-2', status: 'running' }),
            ],
        });
        applyDelegationProgress(client, {
            delegationId: 'task-1',
            sessionId: 'child-a',
            step: 'Running tests',
        });
        expect(read()?.sessions).toEqual([
            entry('child-a', 'host-a', {
                delegationId: 'task-1',
                status: 'running',
                step: 'Running tests',
            }),
            entry('child-b', 'host-a', { delegationId: 'task-2', status: 'running' }),
        ]);
        expect(client.getQueryState(feedKey(['host-a']))?.isInvalidated).toBe(false);
    });

    it('clears the step when the Chat is between steps', () => {
        const { client, read } = setup({
            sessions: [entry('child-a', 'host-a', { delegationId: 'task-1', step: 'Reading' })],
        });
        applyDelegationProgress(client, { delegationId: 'task-1', sessionId: 'child-a' });
        expect(read()?.sessions[0]).not.toHaveProperty('step');
    });

    it('leaves an entry of a later task alone, because that task replaced the reporter', () => {
        const feed: Feed = {
            sessions: [entry('child-a', 'host-a', { delegationId: 'task-2', step: 'Newer' })],
        };
        const { client, read } = setup(feed);
        applyDelegationProgress(client, {
            delegationId: 'task-1',
            sessionId: 'child-a',
            step: 'Stale',
        });
        expect(read()).toBe(feed);
    });

    it('ignores a Session no cached read lists, and a feed with no cached read', () => {
        const feed: Feed = { sessions: [entry('child-a', 'host-a', { delegationId: 'task-1' })] };
        const { client, read } = setup(feed);
        applyDelegationProgress(client, {
            delegationId: 'task-1',
            sessionId: 'unknown',
            step: 'Hidden',
        });
        expect(read()).toBe(feed);
        expect(() =>
            applyDelegationProgress(new QueryClient(), {
                delegationId: 'task-1',
                sessionId: 'child-a',
                step: 'Nowhere',
            }),
        ).not.toThrow();
    });

    it('leaves other cached methods untouched', () => {
        const { client } = setup({
            sessions: [entry('child-a', 'host-a', { delegationId: 'task-1' })],
        });
        const otherKey = ['git.view', 'badge.snapshot', 'session-a'];
        const other = { sessions: [entry('child-a', 'host-a', { delegationId: 'task-1' })] };
        client.setQueryData(otherKey, other);
        applyDelegationProgress(client, {
            delegationId: 'task-1',
            sessionId: 'child-a',
            step: 'Only the feed',
        });
        expect(client.getQueryData(otherKey)).toBe(other);
    });
});

describe('Delegated Sessions feed wiring in subscribeRuntimeQueryInvalidation', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        useWorkbenchStore.setState({ bootstrap: undefined });
    });

    it('refreshes the creator feed after a record push naming a delegated Session', () => {
        const client = new QueryClient();
        const hostKey = feedKey(['host-a']);
        const otherKey = feedKey(['host-b']);
        client.setQueryData(hostKey, { sessions: [] } satisfies Feed);
        client.setQueryData(otherKey, { sessions: [] } satisfies Feed);
        useWorkbenchStore.setState({
            bootstrap: { sessions, sessionStates: [], terminals: [] } as unknown as BootstrapState,
        });
        const unsubscribe = subscribeRuntimeQueryInvalidation(client);
        expect(mocks.state.handler).toBeDefined();
        mocks.state.handler?.({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: ['child-a'], terminalIds: [] },
        });
        vi.advanceTimersByTime(1600);
        expect(client.getQueryState(hostKey)?.isInvalidated).toBe(true);
        expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false);
        unsubscribe();
    });

    it('patches the cached step from a progress event and cancels pending work on unsubscribe', () => {
        const client = new QueryClient();
        const key = feedKey(['host-a']);
        client.setQueryData(key, {
            sessions: [entry('child-a', 'host-a', { delegationId: 'task-1', status: 'running' })],
        } satisfies Feed);
        useWorkbenchStore.setState({
            bootstrap: { sessions, sessionStates: [], terminals: [] } as unknown as BootstrapState,
        });
        const unsubscribe = subscribeRuntimeQueryInvalidation(client);
        expect(mocks.state.handler).toBeDefined();
        mocks.state.handler?.({
            event: 'agent.delegation.progress',
            payload: { delegationId: 'task-1', sessionId: 'child-a', step: 'Editing' },
        });
        expect(client.getQueryData<Feed>(key)?.sessions[0]).toMatchObject({ step: 'Editing' });
        expect(client.getQueryState(key)?.isInvalidated).toBe(false);
        mocks.state.handler?.({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: ['child-a'], terminalIds: [] },
        });
        unsubscribe();
        vi.advanceTimersByTime(1600);
        expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    });
});
