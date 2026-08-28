import { describe, expect, it } from 'vitest';

import { reconcilePendingTreeRefresh } from '../extension-tree-refresh-state';

describe('extension tree refresh state', () => {
    it('ignores an older root completion and waits for the next root load', () => {
        const pending = { afterRootLoad: 2, id: 'manual-refresh' };

        expect(reconcilePendingTreeRefresh(pending, { started: 2, completed: 2 })).toBe(pending);
        expect(reconcilePendingTreeRefresh(pending, { started: 3, completed: 2 })).toEqual({
            ...pending,
            targetRootLoad: 3,
        });
        expect(reconcilePendingTreeRefresh(pending, { started: 3, completed: 3 })).toBeUndefined();
        expect(reconcilePendingTreeRefresh(pending, { started: 4, completed: 3 })).toBeUndefined();
    });
});
