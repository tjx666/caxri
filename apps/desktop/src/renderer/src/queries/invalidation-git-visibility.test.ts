import type { ServerEvent } from '@caxri/protocol';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

class FakeDocument extends EventTarget {
    visibilityState: DocumentVisibilityState = 'visible';

    show(state: DocumentVisibilityState): void {
        this.visibilityState = state;
        this.dispatchEvent(new Event('visibilitychange'));
    }
}

const SUMMARY_KEY = ['git.summary', { sessionId: 'session-a' }];

function gitChanged(sessionIds: string[] = ['session-a']): void {
    mocks.state.handler?.({
        event: 'git.changed',
        payload: { sessionIds, repositoryIds: ['repo-1'], scope: 'status' },
    });
}

async function mountSummary(
    queryClient: QueryClient,
    queryKey: unknown[] = SUMMARY_KEY,
    queryFunction = vi.fn(() => Promise.resolve({ status: 'clean' })),
) {
    const observer = new QueryObserver(queryClient, {
        queryKey,
        queryFn: queryFunction,
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(queryFunction).toHaveBeenCalledTimes(1));
    return { queryFn: queryFunction, unsubscribe };
}

describe('git.changed while the window is hidden', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('marks mounted Git reads stale and refetches them once when the window shows again', async () => {
        const fakeDocument = new FakeDocument();
        vi.stubGlobal('document', fakeDocument);
        const queryClient = new QueryClient();
        const { queryFn, unsubscribe: unmount } = await mountSummary(queryClient);
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        fakeDocument.show('hidden');
        gitChanged();
        gitChanged();
        gitChanged();
        await Promise.resolve();
        expect(queryClient.getQueryState(SUMMARY_KEY)?.isInvalidated).toBe(true);
        expect(queryFn).toHaveBeenCalledTimes(1);

        fakeDocument.show('visible');
        await vi.waitFor(() =>
            expect(queryClient.getQueryState(SUMMARY_KEY)?.isInvalidated).toBe(false),
        );
        expect(queryFn).toHaveBeenCalledTimes(2);

        // Nothing deferred remains, so a later reveal does not refetch again.
        fakeDocument.show('hidden');
        fakeDocument.show('visible');
        await Promise.resolve();
        expect(queryFn).toHaveBeenCalledTimes(2);
        unsubscribe();
        unmount();
    });

    it('refetches on reveal even when a fetch in flight at hide time cleared the stale mark', async () => {
        const fakeDocument = new FakeDocument();
        vi.stubGlobal('document', fakeDocument);
        const queryClient = new QueryClient();
        const slow = Promise.withResolvers<{ status: string }>();
        const queryFunction = vi.fn(() =>
            queryFunction.mock.calls.length === 2
                ? slow.promise
                : Promise.resolve({ status: 'clean' }),
        );
        const { unsubscribe: unmount } = await mountSummary(
            queryClient,
            SUMMARY_KEY,
            queryFunction,
        );
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        // Start a fetch while visible, hide, then let it resolve with pre-change data.
        gitChanged();
        await vi.waitFor(() => expect(queryFunction).toHaveBeenCalledTimes(2));
        fakeDocument.show('hidden');
        gitChanged();
        slow.resolve({ status: 'stale' });
        await vi.waitFor(() =>
            expect(queryClient.getQueryState(SUMMARY_KEY)?.isInvalidated).toBe(false),
        );

        fakeDocument.show('visible');
        await vi.waitFor(() => expect(queryFunction).toHaveBeenCalledTimes(3));
        unsubscribe();
        unmount();
    });

    it('refetches every Session changed while hidden and still skips a refreshing overview', async () => {
        const fakeDocument = new FakeDocument();
        vi.stubGlobal('document', fakeDocument);
        const queryClient = new QueryClient();
        const sessionA = await mountSummary(queryClient);
        const sessionB = await mountSummary(queryClient, [
            'git.summary',
            { sessionId: 'session-b' },
        ]);
        const untouched = await mountSummary(queryClient, [
            'git.summary',
            { sessionId: 'session-c' },
        ]);
        const overview = await mountSummary(queryClient, [
            'git.overview',
            { sessionId: 'session-a', refresh: true },
        ]);
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        fakeDocument.show('hidden');
        gitChanged(['session-a']);
        gitChanged(['session-b']);
        fakeDocument.show('visible');

        await vi.waitFor(() => expect(sessionA.queryFn).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(sessionB.queryFn).toHaveBeenCalledTimes(2));
        expect(untouched.queryFn).toHaveBeenCalledTimes(1);
        expect(overview.queryFn).toHaveBeenCalledTimes(1);
        unsubscribe();
        for (const mounted of [sessionA, sessionB, untouched, overview]) mounted.unsubscribe();
    });

    it('refetches immediately while the window is visible', async () => {
        vi.stubGlobal('document', new FakeDocument());
        const queryClient = new QueryClient();
        const { queryFn, unsubscribe: unmount } = await mountSummary(queryClient);
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        gitChanged();
        await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
        unsubscribe();
        unmount();
    });
});
