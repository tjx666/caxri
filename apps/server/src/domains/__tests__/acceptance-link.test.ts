import { describe, expect, it } from 'vitest';

import { acceptanceUrl, findAcceptanceLinks } from '../acceptance-link';

const ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER = 'f0e1d2c3-b4a5-4968-8778-695a4b3c2d1e';

describe('acceptance link parsing', () => {
    it('reads a bare report link', () => {
        expect(
            findAcceptanceLinks(`see https://app.lobehub.com/acceptance/${ID} for details`),
        ).toEqual([{ id: ID }]);
    });

    it('reads the round from either parameter name, since a pasted link keeps whichever it was copied with', () => {
        expect(findAcceptanceLinks(`https://app.lobehub.com/acceptance/${ID}?turn=2`)).toEqual([
            { id: ID, round: 2 },
        ]);
        expect(findAcceptanceLinks(`https://app.lobehub.com/acceptance/${ID}?r=3`)).toEqual([
            { id: ID, round: 3 },
        ]);
    });

    it('resolves a deep link into one check back to the report that owns it', () => {
        expect(
            findAcceptanceLinks(`https://app.lobehub.com/acceptance/${ID}/check/render-1?turn=4`),
        ).toEqual([{ id: ID, round: 4 }]);
    });

    it('lower-cases the id so the same report written two ways is one report', () => {
        expect(
            findAcceptanceLinks(`https://app.lobehub.com/acceptance/${ID.toUpperCase()}`),
        ).toEqual([{ id: ID }]);
    });

    it('keeps every mention in order, leaving the repeat rule to each caller', () => {
        const text = `first https://app.lobehub.com/acceptance/${ID}?turn=1 then https://app.lobehub.com/acceptance/${OTHER} and again https://app.lobehub.com/acceptance/${ID}`;
        expect(findAcceptanceLinks(text)).toEqual([
            { id: ID, round: 1 },
            { id: OTHER },
            { id: ID },
        ]);
    });

    it('ignores a look-alike host and a malformed id', () => {
        expect(findAcceptanceLinks(`https://app.lobehub.com.evil.test/acceptance/${ID}`)).toEqual(
            [],
        );
        expect(findAcceptanceLinks('https://app.lobehub.com/acceptance/not-a-uuid')).toEqual([]);
    });

    it('ignores a round that is zero, fractional, or absurdly large', () => {
        for (const query of ['?turn=0', '?turn=1.5', '?turn=99999'])
            expect(findAcceptanceLinks(`https://app.lobehub.com/acceptance/${ID}${query}`)).toEqual(
                [{ id: ID }],
            );
    });

    it('rebuilds the link from the id rather than echoing a decorated paste', () => {
        expect(acceptanceUrl(ID)).toBe(`https://app.lobehub.com/acceptance/${ID}`);
        expect(acceptanceUrl(ID, 3)).toBe(`https://app.lobehub.com/acceptance/${ID}?turn=3`);
    });
});
