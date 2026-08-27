import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { inlineThemeCss } from './inline-theme-css';

const skillDirectory = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(skillDirectory, '../../..');

describe('design-prototype runtime manifest', () => {
    /**
     * SKILL.md promises prototypes every `@/components/ui/*` primitive and shared hook; a new Renderer file must land
     * in `assets/entry.mjs` too or the promise silently rots.
     */
    it('covers every Renderer ui primitive and shared hook', async () => {
        const entry = await readFile(path.join(skillDirectory, 'assets/entry.mjs'), 'utf8');
        const uiDirectory = path.join(repoRoot, 'apps/desktop/src/renderer/src/components/ui');
        const uiModules = (await readdir(uiDirectory))
            .filter((file) => file.endsWith('.tsx'))
            .map((file) => `@/components/ui/${file.replace(/\.tsx$/, '')}`);
        const hooksDirectory = path.join(repoRoot, 'apps/desktop/src/renderer/src/hooks');
        const hookModules = (await readdir(hooksDirectory))
            .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
            .map((file) => `@/hooks/${file.replace(/\.ts$/, '')}`);
        expect(uiModules.length).toBeGreaterThan(0);
        expect(hookModules.length).toBeGreaterThan(0);
        for (const specifier of [...uiModules, ...hookModules]) {
            expect(entry, `add '${specifier}' to assets/entry.mjs and rebuild`).toContain(
                `'${specifier}'`,
            );
        }
    });
});

describe('inlineThemeCss', () => {
    it('inlines the real Renderer stylesheets with no leftover @import', async () => {
        const stylesDirectory = path.join(repoRoot, 'apps/desktop/src/renderer/src/styles');
        const css = inlineThemeCss({
            themeCss: await readFile(path.join(stylesDirectory, 'theme.css'), 'utf8'),
            twAnimateCss: await readFile(
                path.join(repoRoot, 'node_modules/tw-animate-css/dist/tw-animate.css'),
                'utf8',
            ),
            stylesCss: await readFile(path.join(stylesDirectory, 'styles.css'), 'utf8'),
        });
        // Semantic token bridge and the virtual tailwind import must survive inlining.
        expect(css).toContain('--color-background');
        expect(css).toContain("@import 'tailwindcss'");
    });

    it('rejects an @import it cannot inline for file:// prototypes', () => {
        expect(() =>
            inlineThemeCss({
                themeCss: '',
                twAnimateCss: '',
                stylesCss: "@import './terminal-fonts.css';",
            }),
        ).toThrow(/terminal-fonts/);
    });

    it('rejects a restructured import of a stylesheet it normally inlines', () => {
        expect(() =>
            inlineThemeCss({
                themeCss: '',
                twAnimateCss: '',
                stylesCss: '@import "./theme.css" layer(base);',
            }),
        ).toThrow(/theme\.css/);
    });
});
