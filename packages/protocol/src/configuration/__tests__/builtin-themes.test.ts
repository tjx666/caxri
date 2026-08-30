import { contrastRatio } from '@caxri/utils';
import { describe, expect, it } from 'vitest';

import { themeTokensSchema } from '../../domain/domain.js';
import {
    builtinThemeIds,
    builtinThemes,
    builtinThemeSources,
    findMatchingBuiltinTheme,
    normalizeBuiltinTheme,
    solarizedLightTheme,
} from '../builtin-themes.js';

describe('built-in themes', () => {
    it('publishes the reviewed catalog in stable picker order', () => {
        expect(builtinThemes.map((theme) => theme.id)).toEqual([...builtinThemeIds]);
        expect(new Set(builtinThemeIds).size).toBe(builtinThemeIds.length);
        expect(builtinThemeIds.every((id) => !id.startsWith('custom-'))).toBe(true);
        expect(Object.keys(builtinThemeSources)).toEqual([...builtinThemeIds]);

        for (const theme of builtinThemes) {
            expect(themeTokensSchema.parse(theme)).toEqual(theme);
            expect(theme.source).toBe('builtin');
            expect(builtinThemeSources[theme.id as keyof typeof builtinThemeSources].license).toBe(
                'MIT',
            );
        }
    });

    it('keeps primary and secondary text at WCAG AA across app, Terminal, and editor surfaces', () => {
        for (const theme of builtinThemes) {
            const { background, elevated, foreground, muted, surface } = theme.colors;
            for (const backdrop of [background, surface, elevated]) {
                expect(
                    contrastRatio(foreground, backdrop),
                    `${theme.id} foreground on ${backdrop}`,
                ).toBeGreaterThanOrEqual(4.5);
                expect(
                    contrastRatio(muted, backdrop),
                    `${theme.id} muted on ${backdrop}`,
                ).toBeGreaterThanOrEqual(4.5);
            }
            expect(
                contrastRatio(theme.terminal.foreground, theme.terminal.background),
                `${theme.id} Terminal foreground`,
            ).toBeGreaterThanOrEqual(4.5);
            expect(
                contrastRatio(theme.editor.foreground, theme.editor.background),
                `${theme.id} editor foreground`,
            ).toBeGreaterThanOrEqual(4.5);
        }

        for (const role of ['green', 'yellow', 'blue', 'cyan'] as const)
            expect(
                contrastRatio(
                    solarizedLightTheme.terminal[role],
                    solarizedLightTheme.terminal.background,
                ),
                `solarized-light Terminal ${role}`,
            ).toBeGreaterThanOrEqual(4.5);
    });

    it('matches only exact current snapshots and normalizes edited built-ins to custom themes', () => {
        const exact = structuredClone(solarizedLightTheme);
        expect(findMatchingBuiltinTheme(exact)?.id).toBe('solarized-light');
        expect(normalizeBuiltinTheme(exact)).toBe(exact);

        const edited = structuredClone(solarizedLightTheme);
        edited.colors.accent = '#268bd2';
        expect(findMatchingBuiltinTheme(edited)).toBeUndefined();
        expect(normalizeBuiltinTheme(edited)).toMatchObject({
            id: 'custom-solarized-light',
            source: 'custom',
            colors: { accent: '#268bd2' },
        });
    });
});
