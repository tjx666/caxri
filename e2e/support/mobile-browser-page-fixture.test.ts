import { describe, expect, it } from 'vitest';

import { MOBILE_BROWSER_PAGE_TITLE, startMobileBrowserPage } from './mobile-browser-page-fixture';

describe('synthetic in-app browser page', () => {
    it('serves the titled page on loopback, counts fetches, and refuses other paths', async () => {
        const page = await startMobileBrowserPage();
        try {
            expect(page.url).toMatch(/^http:\/\/10\.0\.2\.2:\d+\/caxri-acceptance-page$/u);
            const first = await fetch(page.localUrl);
            expect(await first.text()).toContain(`<title>${MOBILE_BROWSER_PAGE_TITLE}</title>`);
            const second = await fetch(page.localUrl);
            await second.text();
            expect(page.hits()).toBe(2);
            const missing = await fetch(new URL('/other', page.localUrl));
            expect(missing.status).toBe(404);
            expect(page.hits()).toBe(2);
        } finally {
            await page.close();
        }
    });
});
