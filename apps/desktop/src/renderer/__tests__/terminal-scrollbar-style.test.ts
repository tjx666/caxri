import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

describe('Terminal scrollbar styles', () => {
    let styles = '';

    beforeAll(async () => {
        styles = await readFile(new URL('../src/styles/styles.css', import.meta.url), 'utf8');
    });

    it('scopes the narrow transparent scrollbar to xterm custom scroll elements', () => {
        expect(styles).toContain(`.terminal-surface .xterm .xterm-scrollbar.xterm-vertical {
    width: 8px !important;
    background: transparent;
}`);
        expect(styles).toMatch(
            /\.terminal-surface \.xterm \.xterm-scrollbar\.xterm-vertical > \.xterm-slider \{\n\s+width: 8px !important;/,
        );
    });

    it('uses semantic theme tokens for idle and interactive thumb states', () => {
        expect(styles).toContain('background: color-mix(in srgb, var(--muted) 45%, transparent);');
        expect(styles).toContain(
            '.terminal-surface .xterm .xterm-scrollbar.xterm-vertical > .xterm-slider:hover,',
        );
        expect(styles).toContain(
            '.terminal-surface .xterm .xterm-scrollbar.xterm-vertical > .xterm-slider.xterm-active,',
        );
        expect(styles).toContain(
            '.terminal-surface .xterm .xterm-scrollbar.xterm-vertical > .xterm-slider:active',
        );
        expect(styles).toContain(
            'background: color-mix(in srgb, var(--muted) 80%, var(--foreground));',
        );
    });
});
