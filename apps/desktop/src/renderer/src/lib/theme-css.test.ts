import type { ThemeTokens } from '@caxri/protocol';
import { builtinThemes, solarizedLightTheme, themeColorCssVariable } from '@caxri/protocol';
import { contrastRatio } from '@caxri/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyCssTheme } from './theme-css';

/**
 * The suite runs under Vitest's `node` environment (no jsdom, see `vitest.config.ts`), so a real `document` does not
 * exist. `applyCssTheme` only ever calls `document.documentElement.style.setProperty`, so a minimal stub is enough to
 * drive it deterministically, mirroring `lib/motion.test.ts`'s and `commands/execute.test.ts`'s same mock-the-boundary
 * approach for this same missing global.
 */
const setProperty = vi.fn();

beforeEach(() => {
    setProperty.mockClear();
    vi.stubGlobal('document', { documentElement: { style: { setProperty } } });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function themeFixture(): ThemeTokens {
    return {
        id: 'fixture-theme',
        name: 'Fixture Theme',
        source: 'builtin',
        colors: {
            background: '#100000',
            surface: '#200000',
            elevated: '#300000',
            foreground: '#400000',
            muted: '#500000',
            border: '#600000',
            selection: '#700000',
            accent: '#800000',
            success: '#900000',
            warning: '#a00000',
            danger: '#b00000',
            merged: '#c00000',
            chart: '#00c000',
            badge: '#d00000',
            errorBadge: '#d01000',
            warningBadge: '#d02000',
            gitAdded: '#e00000',
            gitModified: '#f00000',
            gitDeleted: '#010000',
            gitUntracked: '#020000',
            gitConflicting: '#030000',
            tabActiveBackground: '#1000ff',
            tabActiveForeground: '#1100ff',
            tabInactiveBackground: '#1200ff',
            tabInactiveForeground: '#1300ff',
            tabHoverBackground: '#1400ff',
            tabHoverForeground: '#1500ff',
            listHoverBackground: '#1600ff',
            listHoverForeground: '#1700ff',
            listFocusBackground: '#1800ff',
            listFocusForeground: '#1900ff',
            listActiveSelectionBackground: '#1a00ff',
            listActiveSelectionForeground: '#1b00ff',
            listInactiveSelectionBackground: '#1c00ff',
            listInactiveSelectionForeground: '#1d00ff',
            titleBarActiveBackground: '#1e00ff',
            titleBarActiveForeground: '#1f00ff',
            titleBarInactiveBackground: '#2000ff',
            titleBarInactiveForeground: '#2100ff',
            shadow: '#2200ff',
        },
        terminal: {
            background: '#010101',
            foreground: '#020202',
            cursor: '#030303',
            selectionBackground: '#040404',
            black: '#050505',
            red: '#060606',
            green: '#070707',
            yellow: '#080808',
            blue: '#090909',
            magenta: '#0a0a0a',
            cyan: '#0b0b0b',
            white: '#0c0c0c',
            brightBlack: '#0d0d0d',
            brightRed: '#0e0e0e',
            brightGreen: '#0f0f0f',
            brightYellow: '#101010',
            brightBlue: '#111111',
            brightMagenta: '#121212',
            brightCyan: '#131313',
            brightWhite: '#141414',
        },
        editor: {
            background: '#c00000',
            foreground: '#d00000',
            lineHighlight: '#e00000',
            selection: '#f00000',
            comment: '#111100',
            keyword: '#222200',
            string: '#333300',
            number: '#444400',
        },
    };
}

describe('applyCssTheme', () => {
    it('writes every theme.colors entry to documentElement.style as a kebab-case custom property', () => {
        const theme = themeFixture();
        applyCssTheme(theme);

        // Derived from the fixture, plus the foregrounds `applyCssTheme` computes, so a new color role
        // is covered here automatically instead of failing on a stale literal.
        const derivedProperties = 9;
        expect(setProperty).toHaveBeenCalledTimes(
            Object.keys(theme.colors).length + derivedProperties,
        );
        for (const [token, value] of Object.entries(theme.colors))
            expect(setProperty).toHaveBeenCalledWith(themeColorCssVariable(token), value);
        expect(setProperty).toHaveBeenCalledWith('--git-added', theme.colors.gitAdded);
    });

    it('derives accessible foregrounds for semantic fill colors in every built-in theme', () => {
        for (const theme of builtinThemes) {
            setProperty.mockClear();
            applyCssTheme(theme);
            const properties = new Map(
                setProperty.mock.calls.map(
                    ([property, value]) => [property as string, value as string] as const,
                ),
            );

            expect(
                contrastRatio(properties.get('--accent-foreground')!, theme.colors.accent),
                `${theme.id} accent foreground`,
            ).toBeGreaterThanOrEqual(4.5);
            expect(
                contrastRatio(properties.get('--danger-foreground')!, theme.colors.danger),
                `${theme.id} danger foreground`,
            ).toBeGreaterThanOrEqual(4.5);
            expect(
                contrastRatio(properties.get('--badge-foreground')!, theme.colors.badge),
                `${theme.id} badge foreground`,
            ).toBeGreaterThanOrEqual(4.5);
            expect(
                contrastRatio(properties.get('--error-badge-foreground')!, theme.colors.errorBadge),
                `${theme.id} error badge foreground`,
            ).toBeGreaterThanOrEqual(4.5);
            expect(
                contrastRatio(
                    properties.get('--warning-badge-foreground')!,
                    theme.colors.warningBadge,
                ),
                `${theme.id} warning badge foreground`,
            ).toBeGreaterThanOrEqual(4.5);
        }

        setProperty.mockClear();
        applyCssTheme(solarizedLightTheme);
        expect(setProperty).toHaveBeenCalledWith('--accent-foreground', '#000000');
    });

    it('derives Switch thumbs that stand out from their track in every built-in theme', () => {
        for (const theme of builtinThemes) {
            setProperty.mockClear();
            applyCssTheme(theme);
            const properties = new Map(
                setProperty.mock.calls.map(
                    ([key, value]) => [key as string, value as string] as const,
                ),
            );
            expect(
                contrastRatio(properties.get('--switch-thumb')!, theme.colors.accent),
                theme.name,
            ).toBeGreaterThanOrEqual(3);
            expect(
                contrastRatio(properties.get('--switch-thumb-off')!, theme.colors.border),
                theme.name,
            ).toBeGreaterThanOrEqual(3);
        }
        setProperty.mockClear();
        applyCssTheme(solarizedLightTheme);
        expect(setProperty).not.toHaveBeenCalledWith('--switch-thumb', '#000000');
    });

    it('never derives a diff stat color less readable than the weaker of success and danger', () => {
        for (const theme of builtinThemes) {
            setProperty.mockClear();
            applyCssTheme(theme);
            const properties = new Map(
                setProperty.mock.calls.map(
                    ([property, value]) => [property as string, value as string] as const,
                ),
            );
            const weakest = Math.min(
                contrastRatio(theme.colors.success, theme.colors.surface),
                contrastRatio(theme.colors.danger, theme.colors.surface),
            );
            for (const property of ['--diff-stat-added', '--diff-stat-removed']) {
                expect(
                    contrastRatio(properties.get(property)!, theme.colors.surface),
                    `${theme.id} ${property}`,
                ).toBeGreaterThanOrEqual(weakest);
            }
        }
    });

    it('never writes properties for theme.terminal or theme.editor tokens', () => {
        applyCssTheme(themeFixture());

        expect(setProperty).not.toHaveBeenCalledWith('--cyan', expect.anything());
        expect(setProperty).not.toHaveBeenCalledWith('--comment', expect.anything());
    });
});
