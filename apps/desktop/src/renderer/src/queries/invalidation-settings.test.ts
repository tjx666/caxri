import type { ServerEvent } from '@caxri/protocol';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

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

import { subscribeRuntimeQueryInvalidation } from './invalidation';

describe('subscribeRuntimeQueryInvalidation after a settings change', () => {
    it('drops cached Agent Actions only after a valid settings change', () => {
        const queryClient = new QueryClient();
        const key = ['agentActions.list', { terminalId: 'terminal-a' }];
        queryClient.setQueryData(key, { actions: [{ invocation: '/old' }] });
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'settings.changed',
            payload: { source: '{}', error: 'invalid settings' },
        });
        expect(queryClient.getQueryData(key)).toBeDefined();

        mocks.state.handler?.({ event: 'settings.changed', payload: { source: '{}' } });
        expect(queryClient.getQueryData(key)).toBeUndefined();
        unsubscribe();
    });

    it('re-asks for delivery status after a settings change, so an ignored check applies at once', () => {
        const queryClient = new QueryClient();
        const summary = ['projectStatus.summary', { sessionId: 'session-a' }] as const;
        const pullRequests = ['session.pullRequests', undefined] as const;
        queryClient.setQueryData(summary, { repositories: [] });
        queryClient.setQueryData(pullRequests, { pullRequests: {} });
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({ event: 'settings.changed', payload: { source: '{}' } });

        expect(queryClient.getQueryState(summary)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(pullRequests)?.isInvalidated).toBe(true);
        unsubscribe();
    });

    it('re-asks for the Agent model defaults after a settings change, so a new launch argument shows as an override', () => {
        const queryClient = new QueryClient();
        const defaults = ['agentChat.readDefaults', { provider: 'claude' }] as const;
        queryClient.setQueryData(defaults, { provider: 'claude', overrides: [], models: [] });
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({ event: 'settings.changed', payload: { source: '{}' } });

        expect(queryClient.getQueryState(defaults)?.isInvalidated).toBe(true);
        unsubscribe();
    });
});
