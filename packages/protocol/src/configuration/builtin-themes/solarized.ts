import type { ThemeTokens } from '../../domain/domain.js';

const solarizedTerminal = {
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
} satisfies Omit<
    ThemeTokens['terminal'],
    'background' | 'foreground' | 'cursor' | 'selectionBackground'
>;

/**
 * VS Code's MIT-licensed Solarized Dark theme, based on Ethan Schoonover's Solarized palette. Source:
 * https://github.com/microsoft/vscode/blob/main/extensions/theme-solarized-dark/themes/solarized-dark-color-theme.json
 */
export const solarizedDarkTheme: ThemeTokens = {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    source: 'builtin',
    colors: {
        background: '#002b36',
        surface: '#00212b',
        elevated: '#073642',
        foreground: '#eee8d5',
        /**
         * Solarized base0 is lifted slightly so secondary UI text clears AA on the base02 elevated surface.
         */
        muted: '#8b9c9d',
        border: '#073642',
        selection: '#005a6f',
        accent: '#2aa198',
        success: '#859900',
        warning: '#b58900',
        danger: '#dc322f',
        /**
         * Solarized violet lifted off `#6c71c4` so the glyph clears 3:1 against both dark chrome surfaces.
         */
        merged: '#8f8fd4',
        badge: '#007acc',
        errorBadge: '#dc322f',
        warningBadge: '#b58900',
        gitAdded: '#81b88b',
        gitModified: '#e2c08d',
        gitDeleted: '#c74e39',
        gitUntracked: '#73c991',
        gitConflicting: '#e4676b',
        tabActiveBackground: '#002b37',
        tabActiveForeground: '#d6dbdb',
        tabInactiveBackground: '#004052',
        /**
         * Solarized's `base1` reads 4.23:1 on the tab fill above, and this theme's `muted` is dimmer still, so neither
         * clears AA. Lifted toward `foreground` only as far as AA needs (4.72:1): far enough below `#eee8d5` that an
         * inactive tab still reads as the quieter one.
         */
        tabInactiveForeground: '#9eaaa7',
        tabHoverBackground: '#073642',
        tabHoverForeground: '#eee8d5',
        listHoverBackground: '#004454aa',
        listHoverForeground: '#eee8d5',
        listFocusBackground: '#073642',
        listFocusForeground: '#eee8d5',
        listActiveSelectionBackground: '#005a6f',
        listActiveSelectionForeground: '#eee8d5',
        listInactiveSelectionBackground: '#00445488',
        listInactiveSelectionForeground: '#eee8d5',
        titleBarActiveBackground: '#002c39',
        titleBarActiveForeground: '#eee8d5',
        titleBarInactiveBackground: '#0e2931',
        titleBarInactiveForeground: '#eee8d5',
        shadow: '#00000073',
    },
    terminal: {
        background: '#002b36',
        foreground: '#839496',
        cursor: '#d30102',
        selectionBackground: '#274642',
        ...solarizedTerminal,
    },
    editor: {
        background: '#002b36',
        foreground: '#839496',
        lineHighlight: '#073642',
        selection: '#274642',
        comment: '#586e75',
        keyword: '#859900',
        string: '#2aa198',
        number: '#d33682',
    },
};

/**
 * VS Code's MIT-licensed Solarized Light theme, based on Ethan Schoonover's Solarized palette. Source:
 * https://github.com/microsoft/vscode/blob/main/extensions/theme-solarized-light/themes/solarized-light-color-theme.json
 */
export const solarizedLightTheme: ThemeTokens = {
    id: 'solarized-light',
    name: 'Solarized Light',
    source: 'builtin',
    colors: {
        background: '#fdf6e3',
        surface: '#eee8d5',
        elevated: '#ddd6c1',
        foreground: '#42545a',
        /**
         * Solarized base01 is darkened slightly so secondary UI text clears AA on the darker raised surface.
         */
        muted: '#4b5e64',
        border: '#d3af86',
        selection: '#dfca88',
        accent: '#b58900',
        success: '#859900',
        warning: '#b58900',
        danger: '#dc322f',
        /**
         * Solarized violet darkened off `#6c71c4` so the glyph clears 3:1 against this light theme's raised surfaces.
         */
        merged: '#5c5fb0',
        badge: '#b58900',
        errorBadge: '#dc322f',
        warningBadge: '#b58900',
        /**
         * The Git extension's light-variant defaults; this is the one built-in whose decorations must read on a light
         * canvas.
         */
        gitAdded: '#587c0c',
        gitModified: '#895503',
        gitDeleted: '#ad0707',
        gitUntracked: '#007100',
        gitConflicting: '#ad0707',
        tabActiveBackground: '#fdf6e3',
        tabActiveForeground: '#42545a',
        tabInactiveBackground: '#d3cbb7',
        /**
         * Unlike the dark presets there is no room to dim this one: raising contrast on a light fill means going
         * darker, and this theme's own `foreground` is already only 4.91:1 on the tab fill, so every AA-passing value
         * lands within a few points of it. The active and inactive tab stay apart by their fills (`#fdf6e3` against
         * `#d3cbb7`) rather than by label brightness.
         */
        tabInactiveForeground: '#42545a',
        tabHoverBackground: '#ddd6c1',
        tabHoverForeground: '#42545a',
        listHoverBackground: '#dfca8844',
        listHoverForeground: '#42545a',
        listFocusBackground: '#ddd6c1',
        listFocusForeground: '#42545a',
        listActiveSelectionBackground: '#dfca88',
        /**
         * Upstream's `#6c6c6c` is 3.24:1 on either selection fill. A selected row already announces itself through that
         * fill, so its label can simply be the theme's `foreground` without blurring the selection.
         */
        listActiveSelectionForeground: '#42545a',
        listInactiveSelectionBackground: '#d1cbb8',
        listInactiveSelectionForeground: '#42545a',
        titleBarActiveBackground: '#eee8d5',
        titleBarActiveForeground: '#42545a',
        titleBarInactiveBackground: '#f0ece1',
        titleBarInactiveForeground: '#42545a',
        shadow: '#00000073',
    },
    terminal: {
        background: '#fdf6e3',
        /**
         * Solarized base01 replaces base00 so primary Terminal text clears WCAG AA on base3.
         */
        foreground: '#586e75',
        cursor: '#657b83',
        selectionBackground: '#eee8d5',
        ...solarizedTerminal,
        /**
         * Solarized's chromatic ANSI colors are darkened for this light surface so the compact theme preview and
         * ordinary colored Terminal text clear WCAG AA while retaining the palette's hues.
         */
        green: '#687800',
        yellow: '#8a6c00',
        blue: '#226f99',
        cyan: '#1d7771',
    },
    editor: {
        background: '#fdf6e3',
        /**
         * Solarized base01 replaces base00 so primary editor text clears WCAG AA on base3.
         */
        foreground: '#586e75',
        lineHighlight: '#eee8d5',
        selection: '#eee8d5',
        comment: '#93a1a1',
        keyword: '#859900',
        string: '#2aa198',
        number: '#d33682',
    },
};
