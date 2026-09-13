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

    it('preserves an existing alpha channel when the RGB picker changes a color', () => {
        const theme = structuredClone(tokyoNightTheme);
        theme.terminal.selectionBackground = '#55667788';
        const source = `${JSON.stringify(theme, null, 2)}\n`;

        const next = applyThemeColorEdit(
            source,
            theme,
            'terminal',
            'selectionBackground',
            '#aabbcc',
        );

        expect(next.value.terminal.selectionBackground).toBe('#aabbcc88');
        expect(themeTokensSchema.parse(parse(next.source))).toEqual(next.value);
    });
});
