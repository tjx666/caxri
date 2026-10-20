import { describe, expect, it } from 'vitest';

import { UsageKeyIndex } from '../key-index';

describe('UsageKeyIndex', () => {
    it('lets the earliest-created transcript own a unit copied into a later one', () => {
        const index = new UsageKeyIndex();
        index.store('source', { keys: ['a', 'b'], bornAt: 100 });

        const copySkips = index.countedElsewhere('copy', 200);
        expect(copySkips('a')).toBe(true);
        expect(copySkips('c')).toBe(false);
        expect(index.countedElsewhere('source', 100)('a')).toBe(false);
    });

    it('reports a copy scanned first as stale once its source is indexed', () => {
        const index = new UsageKeyIndex();
        expect(index.countedElsewhere('copy', 200)('a')).toBe(false);
        expect(index.store('copy', { keys: ['a', 'c'], bornAt: 200 })).toEqual([]);

        expect(index.store('source', { keys: ['a'], bornAt: 100 })).toEqual(['copy']);
        // Re-indexing an unchanged source does not ask for another rescan.
        expect(index.store('source', { keys: ['a'], bornAt: 100 })).toEqual([]);
        expect(index.countedElsewhere('copy', 200)('a')).toBe(true);
    });

    it('reports a copy whose scan overlapped the indexing of its source', () => {
        const index = new UsageKeyIndex();
        const copySkips = index.countedElsewhere('copy', 200);
        const scannedSince = index.version;
        // The copy's scan already passed the shared unit when its source was indexed.
        expect(copySkips('a')).toBe(false);
        expect(index.store('source', { keys: ['a'], bornAt: 100 })).toEqual([]);

        expect(index.store('copy', { keys: ['a'], bornAt: 200 }, scannedSince)).toEqual(['copy']);
        // A rescan that started after the source was indexed skipped the unit and is final.
        expect(index.store('copy', { keys: ['a'], bornAt: 200 }, index.version)).toEqual([]);
    });

    it('breaks a creation-time tie by reference and forgets a removed record', () => {
        const index = new UsageKeyIndex();
        index.store('b', { keys: ['a'], bornAt: 100 });
        expect(index.store('a', { keys: ['a'], bornAt: 100 })).toEqual(['b']);

        index.store('a', undefined);
        expect(index.countedElsewhere('b', 100)('a')).toBe(false);
    });

    it('reports the copies that must now own a unit when its source is recreated later', () => {
        const index = new UsageKeyIndex();
        index.store('source', { keys: ['a'], bornAt: 100 });
        index.store('copy', { keys: ['a'], bornAt: 200 });
        expect(index.countedElsewhere('copy', 200)('a')).toBe(true);

        // The source is rewritten and now postdates the copy: the copy, not the source, owns the unit.
        const sourceSkips = index.countedElsewhere('source', 300);
        expect(sourceSkips('a')).toBe(true);
        expect(index.store('source', { keys: ['a'], bornAt: 300 })).toEqual(['copy']);

        // The copy's rescan counts the unit and leaves nothing further to rescan.
        expect(index.countedElsewhere('copy', 200)('a')).toBe(false);
        expect(index.store('copy', { keys: ['a'], bornAt: 200 })).toEqual([]);
    });

    it('detects a later bornAt that arrives only through store', () => {
        const index = new UsageKeyIndex();
        index.store('source', { keys: ['a'], bornAt: 100 });
        index.store('copy', { keys: ['a'], bornAt: 200 });

        expect(index.store('source', { keys: ['a'], bornAt: 300 })).toEqual(['copy']);
    });
});
