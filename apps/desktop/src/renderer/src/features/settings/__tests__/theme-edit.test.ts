import {
    draculaTheme,
    findMatchingBuiltinTheme,
    solarizedLightTheme,
    themeTokensSchema,
    tokyoNightTheme,
} from '@caxri/protocol';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';

import { applyBuiltinTheme, applyThemeColorEdit } from '../theme-edit';

describe('theme editing', () => {
    it('selects an exact built-in snapshot without discarding existing JSONC comments', () => {
        const source = `${JSON.stringify(draculaTheme, null, 2).replace(
            '  "id"',
            '  // Keep this note when changing presets.\n  "id"',
        )}\n`;

        const next = applyBuiltinTheme(source, solarizedLightTheme);

        expect(next.source).toContain('// Keep this note when changing presets.');
        expect(themeTokensSchema.parse(parse(next.source))).toEqual(solarizedLightTheme);
        expect(next.value).toEqual(solarizedLightTheme);
        expect(next.value).not.toBe(solarizedLightTheme);
    });

    it('detaches a built-in identity as soon as one color changes', () => {
        const source = `${JSON.stringify(tokyoNightTheme, null, 2)}\n`;

        const next = applyThemeColorEdit(
            source,
            tokyoNightTheme,
            'terminal',
            'background',
            '#101014',
        );

        expect(next.value).toMatchObject({
            id: 'custom-tokyo-night',
            source: 'custom',
            terminal: { background: '#101014' },
        });
        expect(findMatchingBuiltinTheme(next.value)).toBeUndefined();
        expect(themeTokensSchema.parse(parse(next.source))).toEqual(next.value);
    });
});
