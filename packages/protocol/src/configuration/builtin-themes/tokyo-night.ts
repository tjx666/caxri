import type { ThemeTokens } from '../../domain/domain.js';

/**
 * Enkia's MIT-licensed Tokyo Night theme. Source:
 * https://github.com/tokyo-night/tokyo-night-vscode-theme/blob/master/themes/tokyo-night-color-theme.json
 */
export const tokyoNightTheme: ThemeTokens = {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    source: 'builtin',
    colors: {
        background: '#1a1b26',
        surface: '#16161e',
        elevated: '#202330',
        foreground: '#a9b1d6',
        muted: '#9699a8',
        border: '#101014',
        selection: '#29355a',
        accent: '#7aa2f7',
        success: '#73daca',
        warning: '#e0af68',
        danger: '#f7768e',
        merged: '#bb9af7',
        chart: '#73daca',
        badge: '#3d59a1',
        errorBadge: '#f7768e',
        warningBadge: '#e0af68',
        gitAdded: '#449dab',
        gitModified: '#6183bb',
        gitDeleted: '#914c54',
        gitUntracked: '#449dab',
        /**
         * Tokyo Night ships `#e0af68cc`; the alpha is dropped because Caxri theme colors are opaque hex and the
         * decoration is already the quietest text on the row.
         */
        gitConflicting: '#e0af68',
        tabActiveBackground: '#16161e',
        tabActiveForeground: '#a9b1d6',
        /**
         * Tokyo Night paints both tab states `#16161e` and separates them with `tab.activeBorderTop` instead. Caxri
         * draws that accent only on the focused pane, so in a split the unfocused pane had no cue left at all: same
         * fill, and a label the contrast floor pushes up toward the active one. Dropping to the palette's darkest
         * chrome value restores the fill step, and it also puts this theme's comment grey back above AA (4.65:1), which
         * the shared `#16161e` fill was 4.40:1 short of.
         */
        tabInactiveBackground: '#101014',
        tabInactiveForeground: '#787c99',
        tabHoverBackground: '#202330',
        tabHoverForeground: '#a9b1d6',
        listHoverBackground: '#13131a',
        listHoverForeground: '#a9b1d6',
        listFocusBackground: '#1c1d29',
        listFocusForeground: '#a9b1d6',
        listActiveSelectionBackground: '#202330',
        listActiveSelectionForeground: '#a9b1d6',
        listInactiveSelectionBackground: '#1c1d29',
        listInactiveSelectionForeground: '#a9b1d6',
        titleBarActiveBackground: '#16161e',
        /**
         * The focused window's own title has to be readable, so the comment grey gives way to `foreground` (8.52:1).
         * The inactive pairing below keeps it, since an unfocused window is meant to recede.
         */
        titleBarActiveForeground: '#a9b1d6',
        titleBarInactiveBackground: '#16161e',
        titleBarInactiveForeground: '#787c99',
        /**
         * Tokyo Night sets `widget.shadow` to a fully transparent white, which is the author turning widget shadows off
         * rather than an unset key. Kept as written: an opaque fallback here would put a shadow under every popup the
         * theme deliberately leaves flat.
         */
        shadow: '#ffffff00',
    },
    terminal: {
        background: '#16161e',
        /**
         * The editor foreground replaces Tokyo Night's dim Terminal default so primary text clears WCAG AA.
         */
        foreground: '#a9b1d6',
        cursor: '#c0caf5',
        selectionBackground: '#29355a',
        black: '#363b54',
        red: '#f7768e',
        green: '#73daca',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#787c99',
        brightBlack: '#363b54',
        brightRed: '#f7768e',
        brightGreen: '#73daca',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#acb0d0',
    },
    editor: {
        background: '#1a1b26',
        foreground: '#a9b1d6',
        lineHighlight: '#1e202e',
        selection: '#29355a',
        comment: '#51597d',
        keyword: '#bb9af7',
        string: '#9ece6a',
        number: '#ff9e64',
    },
};
