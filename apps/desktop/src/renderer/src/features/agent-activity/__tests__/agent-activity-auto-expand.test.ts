import { describe, expect, it } from 'vitest';

import { groupsToAutoExpand } from '../agent-activity-auto-expand';

const counts = (entries: Array<[string, number]>) =>
    new Map(entries) as never as Map<never, number>;

describe('groupsToAutoExpand', () => {
    it('reopens a collapsed attention group whose count rose', () => {
        expect(
            groupsToAutoExpand(
                counts([['attention', 1]]),
                counts([['attention', 2]]),
                new Set(['attention'] as never[]),
            ),
        ).toEqual(['attention']);
    });
    it('keeps a collapse when the count is flat, fell, or is first observed (a new group after that reopens)', () => {
        const collapsed = new Set(['attention', 'failed'] as never[]);
        expect(
            groupsToAutoExpand(counts([['attention', 2]]), counts([['attention', 2]]), collapsed),
        ).toEqual([]);
        expect(
            groupsToAutoExpand(counts([['attention', 2]]), counts([['attention', 1]]), collapsed),
        ).toEqual([]);
        expect(groupsToAutoExpand(undefined, counts([['failed', 3]]), collapsed)).toEqual([]);
        expect(groupsToAutoExpand(counts([]), counts([['failed', 3]]), collapsed)).toEqual([
            'failed',
        ]);
    });
    it('ignores quiet groups and groups already open', () => {
        expect(
            groupsToAutoExpand(
                counts([['idle', 1]]),
                counts([['idle', 4]]),
                new Set(['idle'] as never[]),
            ),
        ).toEqual([]);
        expect(
            groupsToAutoExpand(counts([['failed', 1]]), counts([['failed', 4]]), new Set<never>()),
        ).toEqual([]);
    });
});
