import { describe, expect, it } from 'vitest';

import {
    MAX_DISMISSED_DELEGATIONS,
    parseDismissedDelegations,
    withDismissedDelegations,
} from '../agent-chat-dismissed-delegations';

describe('parseDismissedDelegations', () => {
    it('keeps only non-empty string ids and treats anything else as nothing stored', () => {
        expect(parseDismissedDelegations(['delegation:a', '', 3, null, 'delegation:b'])).toEqual([
            'delegation:a',
            'delegation:b',
        ]);
        expect(parseDismissedDelegations(undefined)).toEqual([]);
        expect(parseDismissedDelegations({ a: 1 })).toEqual([]);
    });
});

describe('withDismissedDelegations', () => {
    it('appends new ids once and moves a repeated one to the newest end', () => {
        expect(withDismissedDelegations(['a', 'b'], ['a', 'c', 'c'])).toEqual(['b', 'a', 'c']);
    });

    it('keeps only the newest ids past the bound', () => {
        const stored = Array.from(
            { length: MAX_DISMISSED_DELEGATIONS },
            (_, index) => `old-${index}`,
        );
        const next = withDismissedDelegations(stored, ['new']);
        expect(next).toHaveLength(MAX_DISMISSED_DELEGATIONS);
        expect(next[0]).toBe('old-1');
        expect(next.at(-1)).toBe('new');
    });
});
