import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { cancelViewContainerQuery, isViewContainerQueryEnabled } from '../view-container-activity';

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
