import { contrastRatio } from '@caxri/utils';
import { describe, expect, it } from 'vitest';

import { themeTokensSchema } from '../../domain/domain.js';
import {
    builtinThemeIds,
    builtinThemes,
    builtinThemeSources,
    solarizedLightTheme,
    vscodeLightPlusTheme,
} from '../builtin-themes/index.js';
import {
    findMatchingBuiltinTheme,
    normalizeBuiltinTheme,
    upgradeThemeColors,
} from '../theme-roles.js';

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

    /**
     * Three of the eight themes used to paint hover, keyboard focus, and selection in one identical fill, which left a
     * keyboard user with nothing marking the row they were on. Asserted across every theme rather than the three that
     * were broken, because the two ways it happened (an upstream that only distinguishes two of the three states, and
     * an importer fallback that collapsed all four onto one role) can reach any of them. See issue #1006.
     */
    it('keeps list hover, keyboard focus, and selection visually apart in every theme', () => {
        for (const theme of builtinThemes) {
            const { listActiveSelectionBackground, listFocusBackground, listHoverBackground } =
                theme.colors;
            expect(
                new Set([listHoverBackground, listFocusBackground, listActiveSelectionBackground])
                    .size,
                `${theme.id} list state fills`,
            ).toBe(3);
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

        for (const light of [solarizedLightTheme, vscodeLightPlusTheme])
            for (const role of ['green', 'yellow', 'blue', 'cyan'] as const)
                expect(
                    contrastRatio(light.terminal[role], light.terminal.background),
                    `${light.id} Terminal ${role}`,
                ).toBeGreaterThanOrEqual(4.5);
        // Light+ also keeps its bright hues and the coded editor tokens legible on its white canvas.
        for (const role of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const)
            expect(
                contrastRatio(
                    vscodeLightPlusTheme.terminal[
                        `bright${role[0].toUpperCase()}${role.slice(1)}` as 'brightRed'
                    ],
                    vscodeLightPlusTheme.terminal.background,
                ),
                `vscode-light-plus Terminal bright ${role}`,
            ).toBeGreaterThanOrEqual(4.5);
        for (const token of ['comment', 'keyword', 'string', 'number'] as const)
            expect(
                contrastRatio(
                    vscodeLightPlusTheme.editor[token],
                    vscodeLightPlusTheme.editor.background,
                ),
                `vscode-light-plus editor ${token}`,
            ).toBeGreaterThanOrEqual(4.5);
    });

    /**
     * Regression: `merged` shipped after these presets, so a `theme.json` saved earlier has no such key. Backfilling it
     * with one fixed hex made every non-Dracula preset stop matching its catalog entry, which downgraded it to
     * `custom-*`, and `ConfigService` persists that downgrade. Recovery has to come from the preset itself.
     */
    it('restores a color role added after a saved preset was written, without losing built-in identity', () => {
        for (const theme of builtinThemes) {
            const saved = structuredClone(theme) as { colors: Record<string, string> };
            delete saved.colors.merged;

            const upgraded = themeTokensSchema.parse(upgradeThemeColors(saved));
            expect(upgraded.colors.merged, theme.id).toBe(theme.colors.merged);
            expect(findMatchingBuiltinTheme(upgraded)?.id, theme.id).toBe(theme.id);
            expect(normalizeBuiltinTheme(upgraded).source, theme.id).toBe('builtin');
        }
    });

    /**
     * A release that adds a role and retunes an existing one: the saved built-in snapshot follows the catalog and keeps
     * its built-in identity instead of being demoted to `custom-*` with the old colors (issue #2604).
     */
    it('refreshes a built-in snapshot that lacks a role added since it was saved', () => {
        const saved = structuredClone(solarizedLightTheme) as {
            colors: Record<string, string>;
        };
        delete saved.colors.merged;
        saved.colors.accent = '#123456';

        const upgraded = themeTokensSchema.parse(upgradeThemeColors(saved));
        expect(upgraded.colors).toEqual(solarizedLightTheme.colors);
        const normalized = normalizeBuiltinTheme(upgraded);
        expect(normalized.source).toBe('builtin');
        expect(normalized.id).toBe(solarizedLightTheme.id);
    });

    it('keeps the saved colors of a custom theme that lacks a role and only fills the gap', () => {
        const saved = {
            ...structuredClone(solarizedLightTheme),
            id: 'custom-solarized-light',
            source: 'custom',
        } as { colors: Record<string, string> };
        delete saved.colors.merged;
        saved.colors.accent = '#123456';

        const upgraded = themeTokensSchema.parse(upgradeThemeColors(saved));
        expect(upgraded.colors.accent).toBe('#123456');
        expect(upgraded.colors.merged).toBeDefined();
    });

    it('falls back to a custom theme own accent, and leaves non-theme input to the schema', () => {
        const custom = structuredClone(solarizedLightTheme) as {
            colors: Record<string, string>;
            id: string;
            source: string;
        };
        custom.id = 'custom-mine';
        custom.source = 'custom';
        delete custom.colors.merged;
        expect(themeTokensSchema.parse(upgradeThemeColors(custom)).colors.merged).toBe(
            solarizedLightTheme.colors.accent,
        );

        // Charts painted `success` before the chart role existed, and a custom theme keeps that color.
        const withoutChart = structuredClone(custom);
        delete withoutChart.colors.chart;
        expect(themeTokensSchema.parse(upgradeThemeColors(withoutChart)).colors.chart).toBe(
            solarizedLightTheme.colors.success,
        );

        // A theme that already carries the role is returned untouched, and junk stays the schema's problem.
        const intact = structuredClone(solarizedLightTheme);
        expect(upgradeThemeColors(intact)).toBe(intact);
        for (const junk of [undefined, null, 42, 'theme', {}, { colors: 'nope' }])
            expect(upgradeThemeColors(junk)).toBe(junk);
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
