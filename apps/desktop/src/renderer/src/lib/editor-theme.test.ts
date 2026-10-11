import type { ThemeTokens } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The suite runs under Vitest's `node` environment (no jsdom, see `vitest.config.ts`), and even under a DOM environment
 * `../lib/monaco` pulls in the real `monaco-editor` module plus its Web Worker loaders at import time (see
 * `./monaco.ts`). `applyEditorTheme` only ever calls `monaco.editor.defineTheme`/`monaco.editor.setTheme`, so a minimal
 * mock of the module's `monaco` export is enough to drive it deterministically, mirroring `editor-loader.test.ts`'s
 * approach to the same module.
 */
const mocks = vi.hoisted(() => ({
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
}));

vi.mock('./monaco', () => ({
    monaco: {
        editor: {
            defineTheme: mocks.defineTheme,
            setTheme: mocks.setTheme,
        },
    },
}));

import { applyEditorTheme, resetAppliedEditorTheme } from './editor-theme';

/**
 * `applyEditorTheme` remembers the last definition it applied, so each case starts from a Monaco that has not seen any
 * Caxri theme yet.
 */
beforeEach(() => {
    resetAppliedEditorTheme();
    mocks.defineTheme.mockClear();
    mocks.setTheme.mockClear();
});

/**
 * Content-free fixture covering every field `applyEditorTheme` reads. Uses distinct hex colors per field so a
 * copy-paste field mix-up in the source would fail an assertion below.
 */
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
            success: '#00ff00',
            warning: '#a00000',
            danger: '#ff0000',
            merged: '#c000c0',
            chart: '#00c000',
            badge: '#d000d0',
            errorBadge: '#d010d0',
            warningBadge: '#d020d0',
            gitAdded: '#e000e0',
            gitModified: '#f000f0',
            gitDeleted: '#010001',
            gitUntracked: '#020002',
            gitConflicting: '#030003',
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
            cyan: '#00ffff',
            white: '#0b0b0b',
            brightBlack: '#0c0c0c',
            brightRed: '#0d0d0d',
            brightGreen: '#0e0e0e',
            brightYellow: '#0f0f0f',
            brightBlue: '#101010',
            brightMagenta: '#111111',
            brightCyan: '#121212',
            brightWhite: '#131313',
        },
        editor: {
            background: '#282a36',
            foreground: '#c00000',
            lineHighlight: '#d00000',
            selection: '#e00000',
            comment: '#111100',
            keyword: '#222200',
            string: '#333300',
            number: '#444400',
        },
    };
}

describe('applyEditorTheme', () => {
    it('defines and activates a single caxri-active Monaco theme', () => {
        applyEditorTheme(themeFixture());

        expect(mocks.defineTheme).toHaveBeenCalledTimes(1);
        expect(mocks.defineTheme).toHaveBeenCalledWith('caxri-active', expect.any(Object));
        expect(mocks.setTheme).toHaveBeenCalledWith('caxri-active');
    });

    it('picks the vs-dark Monaco base theme for a dark editor background', () => {
        applyEditorTheme(themeFixture());

        const [, definition] = mocks.defineTheme.mock.calls.at(-1) as [string, { base: string }];
        expect(definition.base).toBe('vs-dark');
    });

    it('maps syntax tokens to editor.* fields, stripped of the leading #', () => {
        const theme = themeFixture();
        applyEditorTheme(theme);

        const [, definition] = mocks.defineTheme.mock.calls.at(-1) as [
            string,
            { rules: Array<{ token: string; foreground: string }> },
        ];
        const byToken = new Map(definition.rules.map((rule) => [rule.token, rule.foreground]));

        expect(byToken.get('comment')).toBe('111100');
        expect(byToken.get('keyword')).toBe('222200');
        expect(byToken.get('string')).toBe('333300');
        expect(byToken.get('number')).toBe('444400');
    });

    it('routes JSON env-var and key tokens through terminal.cyan rather than editor.string', () => {
        const theme = themeFixture();
        applyEditorTheme(theme);

        const [, definition] = mocks.defineTheme.mock.calls.at(-1) as [
            string,
            { rules: Array<{ token: string; foreground: string }> },
        ];
        const byToken = new Map(definition.rules.map((rule) => [rule.token, rule.foreground]));

        expect(byToken.get('variable.env')).toBe('00ffff');
        expect(byToken.get('string.key.json')).toBe('00ffff');
        // JSON string values reuse editor.string, not terminal.cyan.
        expect(byToken.get('string.value.json')).toBe('333300');
    });

    it('maps diff-syntax tokens to colors.muted/success/danger', () => {
        const theme = themeFixture();
        applyEditorTheme(theme);

        const [, definition] = mocks.defineTheme.mock.calls.at(-1) as [
            string,
            { rules: Array<{ token: string; foreground: string }> },
        ];
        const byToken = new Map(definition.rules.map((rule) => [rule.token, rule.foreground]));

        expect(byToken.get('meta.diff')).toBe('500000');
        expect(byToken.get('markup.inserted')).toBe('00ff00');
        expect(byToken.get('markup.deleted')).toBe('ff0000');
    });

    it('maps editor chrome colors straight from ThemeTokens.editor', () => {
        const theme = themeFixture();
        applyEditorTheme(theme);

        const [, definition] = mocks.defineTheme.mock.calls.at(-1) as [
            string,
            { colors: Record<string, string> },
        ];

        expect(definition.colors['editor.background']).toBe('#282a36');
        expect(definition.colors['editor.foreground']).toBe('#c00000');
        expect(definition.colors['editor.lineHighlightBackground']).toBe('#d00000');
        expect(definition.colors['editor.selectionBackground']).toBe('#e00000');
    });

    it('composites diff-editor backgrounds by appending a fixed alpha to the opaque success/danger hex', () => {
        const theme = themeFixture();
        applyEditorTheme(theme);

        const [, definition] = mocks.defineTheme.mock.calls.at(-1) as [
            string,
            { colors: Record<string, string> },
        ];

        expect(definition.colors['diffEditor.insertedTextBackground']).toBe('#00ff0020');
        expect(definition.colors['diffEditor.removedTextBackground']).toBe('#ff000050');
        // The gutter markers reuse the raw, unmodified colors.success/danger tokens.
        expect(definition.colors['editorGutter.addedBackground']).toBe('#00ff00');
        expect(definition.colors['editorGutter.deletedBackground']).toBe('#ff0000');
    });

    it('strips a pre-existing alpha byte before compositing the diff-editor background alpha', () => {
        const theme = themeFixture();
        // colors.success/danger already carry an alpha byte here, unlike the opaque fixture above.
        theme.colors.success = '#00ff00cc';
        theme.colors.danger = '#ff0000cc';
        applyEditorTheme(theme);

        const [, definition] = mocks.defineTheme.mock.calls.at(-1) as [
            string,
            { colors: Record<string, string> },
        ];

        // `diffEditor.*Background` explicitly slices to the 6-digit prefix before appending its own
        // alpha, so the pre-existing `cc` alpha byte never survives into the composited color.
        expect(definition.colors['diffEditor.insertedTextBackground']).toBe('#00ff0020');
        expect(definition.colors['diffEditor.removedTextBackground']).toBe('#ff000050');
    });

    it('passes 8-digit markup token foregrounds through; Monaco ColorMap keeps only the RGB group', () => {
        const theme = themeFixture();
        theme.colors.success = '#00ff00cc';
        theme.colors.danger = '#ff0000cc';
        applyEditorTheme(theme);

        const [, definition] = mocks.defineTheme.mock.calls.at(-1) as [
            string,
            { rules: Array<{ token: string; foreground: string }> },
        ];
        const byToken = new Map(definition.rules.map((rule) => [rule.token, rule.foreground]));

        // slice(1) keeps the alpha suffix. monaco-editor ColorMap
        // (`/^#?([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/`) accepts that string and stores only group 1.
        expect(byToken.get('markup.inserted')).toBe('00ff00cc');
        expect(byToken.get('markup.deleted')).toBe('ff0000cc');
    });

    it('skips redefining the theme when nothing it maps has changed', () => {
        applyEditorTheme(themeFixture());
        applyEditorTheme(themeFixture());

        expect(mocks.defineTheme).toHaveBeenCalledTimes(1);
        expect(mocks.setTheme).toHaveBeenCalledTimes(1);
    });

    it('redefines the theme when a mapped color changes', () => {
        applyEditorTheme(themeFixture());
        const changed = themeFixture();
        changed.editor.keyword = '#abcdef';
        applyEditorTheme(changed);

        expect(mocks.defineTheme).toHaveBeenCalledTimes(2);
        expect(mocks.setTheme).toHaveBeenCalledTimes(2);
    });
});
