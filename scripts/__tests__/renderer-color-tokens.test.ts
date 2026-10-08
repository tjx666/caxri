import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { rawOnlyColorNames, registeredColorRoles } from '../renderer-color-tokens';

const themeCssPath = resolve(
    import.meta.dirname,
    '../../apps/desktop/src/renderer/src/styles/theme.css',
);

interface ThemeColorNames {
    bridged: string[];
    rawOnly: string[];
}

async function readThemeColorNames(): Promise<ThemeColorNames> {
    const css = await readFile(themeCssPath, 'utf8');
    const bridge = /@theme inline\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    const bridged = bridge
        .matchAll(/--color-([a-z0-9-]+)\s*:/g)
        .map((match) => match[1])
        .toArray();
    const rawOnly = root
        .matchAll(/^\s*--([a-z0-9-]+)\s*:\s*(?:#|rgb|hsl|color-mix)/gm)
        .map((match) => match[1])
        .filter((name) => !bridged.includes(name))
        .toArray();
    return { bridged, rawOnly };
}

const alphabetical = (a: string, b: string): number => a.localeCompare(b);

/**
 * `scripts/renderer-color-tokens.ts` exists because `caxri/registered-color-utilities` runs synchronously and may not
 * read a file. That makes it a copy of `theme.css`, and a copy is only safe while something fails when it drifts, a
 * role added to the bridge but not to the list would be reported as an unregistered color, and one removed from the
 * bridge would stop being reported at all.
 */
describe('renderer color tokens mirror theme.css', () => {
    it('lists exactly the roles bridged by @theme inline', async () => {
        const { bridged } = await readThemeColorNames();

        expect(bridged.toSorted(alphabetical)).toEqual(registeredColorRoles.toSorted(alphabetical));
    });

    it('lists exactly the :root colors left out of the bridge', async () => {
        const { rawOnly } = await readThemeColorNames();

        expect(rawOnly.toSorted(alphabetical)).toEqual(rawOnlyColorNames.toSorted(alphabetical));
    });
});
