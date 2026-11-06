import { describe, expect, it } from 'vitest';

import { parsePortalItems, serializePortalItems } from '../portal-persistence';

describe('portal persistence', () => {
    it('round-trips items, their order, and the active item per Session', () => {
        const bySession = {
            s1: { paths: ['a', 'b', 'c'], activePath: 'b' },
            s2: { paths: ['z'], activePath: 'z' },
        };
        const stored = structuredClone(serializePortalItems(bySession));
        expect(parsePortalItems(stored)).toEqual(bySession);
    });

    it('starts closed for a missing, foreign-version, or malformed entry', () => {
        expect(parsePortalItems(undefined)).toEqual({});
        expect(parsePortalItems({ version: 99, sessions: { s: { paths: ['a'] } } })).toEqual({});
        expect(parsePortalItems({ version: 1, sessions: { s: { paths: [] }, t: 4 } })).toEqual({});
    });

    it('drops non-string and duplicate paths and repairs a stale active item', () => {
        expect(
            parsePortalItems({
                version: 1,
                sessions: { s: { paths: ['a', 7, 'a', 'b'], activePath: 'gone' } },
            }),
        ).toEqual({ s: { paths: ['a', 'b'], activePath: 'a' } });
    });
});
