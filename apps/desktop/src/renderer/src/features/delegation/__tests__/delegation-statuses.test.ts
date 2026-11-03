import { MAX_DELEGATION_STATUS_IDS } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { delegationStatusIdChunks } from '../delegation-statuses';

describe('delegationStatusIdChunks', () => {
    it('sorts and de-duplicates the IDs so the same set always has the same query key', () => {
        expect(delegationStatusIdChunks(['b', 'a', 'b'])).toEqual([['a', 'b']]);
        expect(delegationStatusIdChunks(['x', 'y'])).toEqual(delegationStatusIdChunks(['y', 'x']));
    });

    it('asks nothing for no IDs', () => {
        expect(delegationStatusIdChunks([])).toEqual([]);
    });

    it('splits at the most IDs one read accepts', () => {
        const ids = Array.from(
            { length: MAX_DELEGATION_STATUS_IDS + 3 },
            (_, index) => `task-${String(index).padStart(3, '0')}`,
        );
        expect(delegationStatusIdChunks(ids).map((chunk) => chunk.length)).toEqual([
            MAX_DELEGATION_STATUS_IDS,
            3,
        ]);
    });
});
