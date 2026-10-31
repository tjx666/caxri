import { describe, expect, it } from 'vitest';

import { refreshTreeThenPullRequest } from '../tree-refresh';

describe('refreshTreeThenPullRequest', () => {
    it('re-reads the pull request only after the tree read settled', async () => {
        const events: string[] = [];
        let settleTree = (): void => {};
        const invalidateQueries = ({ queryKey }: { queryKey: readonly unknown[] }) => {
            events.push(`start ${String(queryKey[0])}`);
            if (queryKey[0] !== 'tree') return Promise.resolve();
            return new Promise<void>((resolve) => {
                settleTree = () => {
                    events.push('settle tree');
                    resolve();
                };
            });
        };
        const refreshed = refreshTreeThenPullRequest(
            { invalidateQueries } as never,
            ['tree'],
            ['pull-request'],
        );
        await Promise.resolve();
        expect(events).toEqual(['start tree']);
        settleTree();
        await refreshed;
        expect(events).toEqual(['start tree', 'settle tree', 'start pull-request']);
    });
});
