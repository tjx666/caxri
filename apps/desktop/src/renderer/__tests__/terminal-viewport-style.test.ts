import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Class-level specificity of a selector made only of class names and `:not()` around classes, which covers every
 * viewport rule compared here.
 */
function classSpecificity(selector: string): number {
    return selector.match(/\.[\w-]+/g)?.length ?? 0;
}

function viewportBackgroundSelectors(css: string): string[] {
    const selectors: string[] = [];
    for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (!/background(?:-color)?\s*:/.test(match[2])) continue;
        const ruleSelectors = match[1].replaceAll(/\/\*[\s\S]*?\*\//g, '').split(',');
        for (const selector of ruleSelectors) {
            const trimmed = selector.trim();
            if (/\.xterm-viewport$/.test(trimmed)) selectors.push(trimmed);
        }
    }
    return selectors;
}

describe('Terminal viewport background', () => {
    let caxriSelectors: string[] = [];
    let xtermSelectors: string[] = [];

    beforeAll(async () => {
        const styles = await readFile(new URL('../src/styles/styles.css', import.meta.url), 'utf8');
        const require = createRequire(import.meta.url);
        const xtermCss = await readFile(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8');
        caxriSelectors = viewportBackgroundSelectors(styles);
        xtermSelectors = viewportBackgroundSelectors(xtermCss);
    });

    // The production build links xterm.css after styles.css, so a tie lets xterm's black viewport
    // paint the command gutter.
    it('clears the viewport background with higher specificity than xterm.css', () => {
        expect(caxriSelectors).toHaveLength(1);
        expect(xtermSelectors.length).toBeGreaterThan(0);
        const caxri = classSpecificity(caxriSelectors[0]);
        for (const selector of xtermSelectors) {
            expect(caxri, selector).toBeGreaterThan(classSpecificity(selector));
        }
    });
});
