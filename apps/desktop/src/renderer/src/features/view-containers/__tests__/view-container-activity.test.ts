import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import {
    cancelViewContainerQuery,
    isViewContainerQueryEnabled,
    resolveHeldWhileHidden,
} from '../view-container-activity';

describe('isViewContainerQueryEnabled', () => {
    it('pauses keep-alive reads while the container is hidden', () => {
        expect(isViewContainerQueryEnabled(false)).toBe(false);
        expect(isViewContainerQueryEnabled(false, true)).toBe(false);
    });

    it('keeps the extra Session or search gate when the container is visible', () => {
        expect(isViewContainerQueryEnabled(true)).toBe(true);
        expect(isViewContainerQueryEnabled(true, false)).toBe(false);
        expect(isViewContainerQueryEnabled(true, true)).toBe(true);
    });
});

describe('resolveHeldWhileHidden', () => {
    it('keeps the last shown input while the container is hidden', () => {
        expect(resolveHeldWhileHidden(false, '/project/a.ts', '/project/b.ts')).toBe(
            '/project/a.ts',
        );
        expect(resolveHeldWhileHidden(false, '/project/a.ts', undefined)).toBe('/project/a.ts');
    });

    it('adopts the live input once the container is visible', () => {
        expect(resolveHeldWhileHidden(true, '/project/a.ts', '/project/b.ts')).toBe(
            '/project/b.ts',
        );
        expect(resolveHeldWhileHidden(true, '/project/a.ts', undefined)).toBeUndefined();
    });

    it('returns the held reference when a custom comparison treats the inputs as the same', () => {
        const held = { sessionId: 'session-1', workbenchProjectId: 'project-1' };
        const live = { sessionId: 'session-1', workbenchProjectId: 'project-1' };
        const isSame = (left: typeof held, right: typeof held) =>
            left.sessionId === right.sessionId &&
            left.workbenchProjectId === right.workbenchProjectId;
        expect(resolveHeldWhileHidden(true, held, live, isSame)).toBe(held);
        const switched = { sessionId: 'session-2', workbenchProjectId: 'project-1' };
        expect(resolveHeldWhileHidden(false, held, switched, isSame)).toBe(held);
        expect(resolveHeldWhileHidden(true, held, switched, isSame)).toBe(switched);
    });
});

describe('cancelViewContainerQuery', () => {
    it('aborts an in-flight keep-alive fetch and resumes when the container is shown again', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false, staleTime: 0 } },
        });
        const pending = Promise.withResolvers<{ entries: string[] }>();
        let seenSignal: AbortSignal | undefined;
        const queryFunction = vi.fn(({ signal }: { signal: AbortSignal }) => {
            seenSignal = signal;
            return pending.promise;
        });
        const queryKey = ['files.list', { directory: '/' }];
        const observer = new QueryObserver(queryClient, {
            queryKey,
            queryFn: queryFunction,
            enabled: true,
            staleTime: 0,
        });
        const unsubscribe = observer.subscribe(() => {});

        try {
            await vi.waitFor(() => expect(queryFunction).toHaveBeenCalledTimes(1));
            expect(seenSignal?.aborted).toBe(false);

            observer.setOptions({
                queryKey,
                queryFn: queryFunction,
                enabled: false,
                staleTime: 0,
            });
            expect(observer.getCurrentResult().fetchStatus).toBe('fetching');
            expect(seenSignal?.aborted).toBe(false);

            await cancelViewContainerQuery(queryClient, queryKey);
            expect(seenSignal?.aborted).toBe(true);

            observer.setOptions({
                queryKey,
                queryFn: queryFunction,
                enabled: true,
                staleTime: 0,
            });
            await vi.waitFor(() => expect(queryFunction).toHaveBeenCalledTimes(2));
            expect(queryFunction.mock.calls[1]?.[0]?.signal.aborted).toBe(false);
        } finally {
            pending.resolve({ entries: [] });
            unsubscribe();
            queryClient.clear();
        }
    });
});
