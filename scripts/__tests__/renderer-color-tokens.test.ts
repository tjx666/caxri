import { describe, expect, it } from 'vitest';

import css from '../../apps/desktop/src/renderer/src/styles/theme.css?raw';
import { rawOnlyColorNames, registeredColorRoles } from '../renderer-color-tokens';

interface ThemeColorNames {
    bridged: string[];
    rawOnly: string[];
}

function readThemeColorNames(): ThemeColorNames {
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
    it('lists exactly the roles bridged by @theme inline', () => {
        const { bridged } = readThemeColorNames();

        expect(bridged.toSorted(alphabetical)).toEqual(registeredColorRoles.toSorted(alphabetical));
    });

    it('lists exactly the :root colors left out of the bridge', () => {
        const { rawOnly } = readThemeColorNames();

        expect(rawOnly.toSorted(alphabetical)).toEqual(rawOnlyColorNames.toSorted(alphabetical));
    });
});
