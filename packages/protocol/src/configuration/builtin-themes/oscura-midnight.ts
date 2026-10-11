import type { ThemeTokens } from '../../domain/domain.js';

/**
 * Narative/Fey's MIT-licensed Oscura Midnight editor palette. The ANSI values follow the matching MIT port. Sources:
 * https://github.com/narative/oscura/blob/main/themes/oscura-midnight.json and
 * https://github.com/jshmllr/oscura/blob/main/ghostty/oscura-midnight
 */
export const oscuraMidnightTheme: ThemeTokens = {
    id: 'oscura-midnight',
    name: 'Oscura Midnight',
    source: 'builtin',
    colors: {
        background: '#0b0b0f',
        surface: '#0b0b0f',
        elevated: '#232323',
        foreground: '#e6e6e6',
        muted: '#868f97',
        border: '#282828',
        selection: '#5a5b63',
        accent: '#e6e7a3',
        success: '#4ebe96',
        warning: '#d2d714',
        danger: '#ff5c5c',
        /**
         * Oscura ships no saturated violet, so this lifts its muted `#6e678e` magenta into a readable glyph color while
         * keeping the palette's low-saturation character.
         */
        merged: '#a89ec9',
        chart: '#4ebe96',
        badge: '#e6e7a3',
        errorBadge: '#ff5c5c',
        warningBadge: '#d2d714',
        gitAdded: '#81b88b',
        /**
         * Oscura deliberately decorates a changed file with plain white instead of a status hue, so these two sit a
         * shade above `foreground`. The row's status letter, not the color, is what still identifies the change here.
         */
        gitModified: '#ffffff',
        gitUntracked: '#ffffff',
        gitDeleted: '#ff5c5c',
        gitConflicting: '#ff5c5c',
        tabActiveBackground: '#0b0b0f',
        tabActiveForeground: '#ffffff',
        tabInactiveBackground: '#0b0b0f',
        tabInactiveForeground: '#868f97',
        tabHoverBackground: '#232323',
        tabHoverForeground: '#e6e6e6',
        /**
         * Upstream Oscura Midnight gives `list.focusBackground` and `list.activeSelectionBackground` the same
         * `#232323`, so a keyboard user cannot tell the row they are on from the row that is selected. Same treatment
         * as `dracula.ts`: one grey at three weights over this theme's near-black canvas: the existing white wash for
         * hover, `#23232399` for focus, the opaque `#232323` for selection. See issue #1006.
         */
        listHoverBackground: '#ffffff08',
        listHoverForeground: '#e6e6e6',
        listFocusBackground: '#23232399',
        listFocusForeground: '#e6e6e6',
        listActiveSelectionBackground: '#232323',
        listActiveSelectionForeground: '#e6e6e6',
        listInactiveSelectionBackground: '#232323',
        listInactiveSelectionForeground: '#e6e6e6',
        titleBarActiveBackground: '#0b0b0f',
        titleBarActiveForeground: '#7e7e7e',
        titleBarInactiveBackground: '#0b0b0f',
        titleBarInactiveForeground: '#6a7782',
        shadow: '#00000073',
    },
    terminal: {
        background: '#0b0b0f',
        foreground: '#e6e6e6',
        cursor: '#e6e6e6',
        selectionBackground: '#5a5b63',
        black: '#0b0b0f',
        red: '#d84f68',
        green: '#4ebe96',
        yellow: '#e6e7a3',
        blue: '#479ffa',
        magenta: '#6e678e',
        cyan: '#54c0a3',
        white: '#c1c1c1',
        brightBlack: '#46474f',
        brightRed: '#ff5c5c',
        brightGreen: '#4ebe96',
        brightYellow: '#f9b98c',
        brightBlue: '#479ffa',
        brightMagenta: '#9099a1',
        brightCyan: '#54c0a3',
        brightWhite: '#e6e6e6',
    },
    editor: {
        background: '#0b0b0f',
        foreground: '#e6e6e6',
        lineHighlight: '#161616',
        selection: '#5a5b63',
        comment: '#46474f',
        keyword: '#9099a1',
        string: '#e6e6e6',
        number: '#f9b98c',
    },
};
