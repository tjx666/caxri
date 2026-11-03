import { describe, expect, it } from 'vitest';

import { maskText, surfaceDocument } from './capture-surface';

describe('capture-surface', () => {
    it('masks Session titles and numbers while keeping their length and punctuation', () => {
        const title = 'admin CLI 下载方式 #2177';
        const masked = maskText(title);
        expect(masked).toBe('xxxxx XXX 文文文文 #0000');
        expect(masked).toHaveLength(title.length);
    });

    it('renders the capture through the prototype runtime theme beside it', () => {
        const page = surfaceDocument('<main class="bg-surface"></main>', 'CDP port 9224');
        expect(page).toContain('./caxri-prototype-theme.js');
        expect(page).toContain('./tailwind-browser.js');
        expect(page).toContain('<main class="bg-surface"></main>');
    });
});
