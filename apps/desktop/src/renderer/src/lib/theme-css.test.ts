import type { ThemeTokens } from '@caxri/protocol';
import { builtinThemes, solarizedLightTheme } from '@caxri/protocol';
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
        warnings: [],
    };
}

describe('applyCssTheme', () => {
    it('writes every theme.colors entry to documentElement.style as a --<key> custom property', () => {
        applyCssTheme(themeFixture());

        expect(setProperty).toHaveBeenCalledTimes(13);
        expect(setProperty).toHaveBeenCalledWith('--background', '#100000');
        expect(setProperty).toHaveBeenCalledWith('--surface', '#200000');
        expect(setProperty).toHaveBeenCalledWith('--foreground', '#400000');
        expect(setProperty).toHaveBeenCalledWith('--accent', '#800000');
        expect(setProperty).toHaveBeenCalledWith('--danger', '#b00000');
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
        }

        setProperty.mockClear();
        applyCssTheme(solarizedLightTheme);
        expect(setProperty).toHaveBeenCalledWith('--accent-foreground', '#000000');
    });

    it('never writes properties for theme.terminal or theme.editor tokens', () => {
        applyCssTheme(themeFixture());

        expect(setProperty).not.toHaveBeenCalledWith('--cyan', expect.anything());
        expect(setProperty).not.toHaveBeenCalledWith('--comment', expect.anything());
    });
});
