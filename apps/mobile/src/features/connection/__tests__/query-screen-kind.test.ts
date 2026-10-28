import { describe, expect, it } from 'vitest';

import { queryScreenKind } from '../query-screen-kind';

const base = { fetchStatus: 'idle', hasData: false, isError: false, itemCount: 0 } as const;

describe('queryScreenKind', () => {
    it('reads offline, not loading, while the disabled query has never fetched', () => {
        expect(queryScreenKind(base)).toBe('offline');
    });

    it('loads only while a fetch is running', () => {
        expect(queryScreenKind({ ...base, fetchStatus: 'fetching' })).toBe('loading');
    });

    it('shows a failure before any data', () => {
        expect(queryScreenKind({ ...base, isError: true })).toBe('error');
    });

    it('keeps a list already read, and names an empty one', () => {
        expect(queryScreenKind({ ...base, hasData: true, itemCount: 2 })).toBe('ready');
        expect(queryScreenKind({ ...base, hasData: true })).toBe('empty');
    });
});
