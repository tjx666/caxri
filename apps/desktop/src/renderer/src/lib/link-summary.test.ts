import { describe, expect, it } from 'vitest';

import { linkSummary } from './link-summary';

describe('linkSummary', () => {
    it('names a GitHub repository and the pull request or issue a link opens', () => {
        expect(linkSummary('https://github.com/acme/widgets/pull/11')).toEqual({
            host: 'github.com',
            detail: 'acme/widgets · #11',
            kind: 'pull',
            isSecure: true,
        });
        expect(
            linkSummary('https://github.com/acme/widgets/issues/7#issuecomment-1'),
        ).toMatchObject({
            detail: 'acme/widgets · #7',
            kind: 'issue',
        });
        expect(linkSummary('https://github.com/acme/widgets/tree/main/src')).toMatchObject({
            detail: 'acme/widgets',
            kind: 'repository',
        });
        expect(linkSummary('https://github.com/acme')?.detail).toBe('acme');
    });

    it('shows the decoded path of any other site, and nothing for its root', () => {
        expect(linkSummary('https://www.example.com/docs/a%20b?tab=1')).toEqual({
            host: 'example.com',
            detail: '/docs/a b?tab=1',
            isSecure: true,
        });
        expect(linkSummary('http://localhost:5173/')).toEqual({
            host: 'localhost',
            isSecure: false,
        });
    });

    it('ignores links that are not web pages', () => {
        expect(linkSummary('mailto:someone@example.com')).toBeUndefined();
        expect(linkSummary('not a url')).toBeUndefined();
    });
});
