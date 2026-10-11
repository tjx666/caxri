import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../..', import.meta.url));
const stylesRoot = join(repoRoot, 'apps/desktop/src/renderer/src/styles');
const sharedThemeFile = 'theme.css';
const rendererEntries = ['styles.css', 'process-explorer.css'];
const semanticColorRoles = [
    'background',
    'surface',
    'elevated',
    'border',
    'foreground',
    'muted',
    'accent',
    'accent-foreground',
    'success',
    'warning',
    'danger',
    'chart',
    'overlay',
    'shadow',
    'indicator',
];

describe('Renderer theme source contract', () => {
    it('keeps one complete semantic theme bootstrap imported by both renderer entries', async () => {
        const cssFiles = (await readdir(stylesRoot)).filter((file) => file.endsWith('.css'));
        const sources = new Map<string, string>(
            await Promise.all(
                cssFiles.map(async (file): Promise<[string, string]> => [
                    file,
                    await readFile(join(stylesRoot, file), 'utf8'),
                ]),
            ),
        );
        expect(
            [...sources].filter(([, source]) => /@theme(?:\s+inline)?\s*\{/.test(source)),
        ).toEqual([[sharedThemeFile, expect.any(String)]]);

        const theme = sources.get(sharedThemeFile) ?? '';
        expect(theme).toContain("@import 'tailwindcss';");
        expect(theme).toContain('--color-*: initial;');
        for (const role of semanticColorRoles) {
            expect(theme).toContain(`--color-${role}: var(--${role});`);
        }
        for (const entry of rendererEntries) {
            expect(sources.get(entry)).toContain(`@import './${sharedThemeFile}';`);
        }
    });

    it('points shadcn metadata at the shared theme source without changing its base style', async () => {
        const components = JSON.parse(
            await readFile(join(repoRoot, 'components.json'), 'utf8'),
        ) as { style: string; tailwind: { baseColor: string; css: string } };

        expect(components).toMatchObject({
            style: 'base-nova',
            tailwind: {
                baseColor: 'zinc',
                css: 'apps/desktop/src/renderer/src/styles/theme.css',
            },
        });
    });
});
