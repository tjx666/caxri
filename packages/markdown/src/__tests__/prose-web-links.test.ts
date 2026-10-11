import { describe, expect, it } from 'vitest';

import { proseWebLinks } from '../prose-web-links';

describe('proseWebLinks', () => {
    it('finds http(s) URLs with their offsets', () => {
        expect(
            proseWebLinks('see https://lobehub.com 流量怎么样, or https://a.dev/x?y=1.'),
        ).toEqual([
            { index: 4, text: 'https://lobehub.com', url: 'https://lobehub.com' },
            { index: 34, text: 'https://a.dev/x?y=1', url: 'https://a.dev/x?y=1' },
        ]);
    });

    it('leaves bare domains, emails, and file paths as text', () => {
        expect(proseWebLinks('example.com me@example.com src/app.ts:12')).toEqual([]);
    });
});
