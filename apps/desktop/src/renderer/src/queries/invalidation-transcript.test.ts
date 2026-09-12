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

/**
 * Split out of `invalidation.test.ts` so both files stay within the repository's file-size budget.
 */
describe('subscribeRuntimeQueryInvalidation transcript queries', () => {
    it('invalidates only the transcript query for the changed Terminal', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-a', withContent: true }],
            { content: 'old' },
        );
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-b', withContent: true }],
            { content: 'other' },
        );
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'agentTranscript.changed',
            payload: { terminalId: 'terminal-a' },
        });

        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-a', withContent: true },
            ])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-b', withContent: true },
            ])?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });

    it('invalidates every transcript after a Server reconnect closes a journal-gap race', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-a', withContent: true }],
            { content: 'old-a' },
        );
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-b', withContent: true }],
            { content: 'old-b' },
        );
        queryClient.setQueryData(['files.browse', { sessionId: 'session-a' }], { entries: [] });
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'host.connectionChanged',
            payload: { status: 'replaced' },
        });

        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-a', withContent: true },
            ])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-b', withContent: true },
            ])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(['files.browse', { sessionId: 'session-a' }])?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });

    it('invalidates the rebound Terminal transcript on a record-scoped state change', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-a', withContent: true }],
            { content: 'old-a' },
        );
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-b', withContent: true }],
            { content: 'old-b' },
        );
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: ['terminal-a'] },
        });

        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-a', withContent: true },
            ])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-b', withContent: true },
            ])?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });

    it('invalidates every transcript when a full state change may replace Terminal bindings', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-a', withContent: true }],
            { content: 'old-a' },
        );
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-b', withContent: true }],
            { content: 'old-b' },
        );
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'terminal.create' },
        });

        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-a', withContent: true },
            ])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-b', withContent: true },
            ])?.isInvalidated,
        ).toBe(true);
        unsubscribe();
    });
});
