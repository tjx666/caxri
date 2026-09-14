import type { ThemeTokens } from '../domain/domain.js';

/**
 * Dracula's official MIT palette, normalized for Caxri's app, Terminal, and Monaco roles. Source:
 * https://github.com/dracula/dracula-theme
 */
export const draculaTheme: ThemeTokens = {
    id: 'dracula',
    name: 'Dracula',
    source: 'builtin',
    colors: {
        background: '#282a36',
        surface: '#21222c',
        elevated: '#343746',
        foreground: '#f8f8f2',
        /**
         * Dracula's comment blue is syntax color, not secondary UI text. This adjusted blue-grey clears WCAG AA on
         * every Caxri chrome surface while preserving the palette's character.
         */
        muted: '#9aa5c4',
        /**
         * Dracula's `tab.border` / darkest UI variant, which is what separates regions in VS Code. Its `panel.border`
         * is the palette's purple and would draw a saturated grid around every Caxri region, so it is not the source.
         */
        border: '#191a21',
        selection: '#44475a',
        /**
         * Dracula paints every "this is the active one" edge pink — `tab.activeBorderTop`, `activityBar.activeBorder`,
         * and `progressBar.background` are all `#ff79c6` — which is exactly the set `accent` covers here. Its
         * `focusBorder` (`#6272a4`) is the comment blue and far too quiet to carry a focus ring, so it is deliberately
         * not the source.
         */
        accent: '#ff79c6',
        success: '#50fa7b',
        warning: '#f1fa8c',
        danger: '#ff5555',
        /**
         * Dracula's canonical purple. It was previously `#d6acff` only because `accent` held `#bd93f9`; with `accent`
         * on the theme's real active-edge pink the palette's own violet is free for the landed-work role.
         */
        merged: '#bd93f9',
        badge: '#ff79c6',
        gitAdded: '#81b88b',
        gitModified: '#8be9fd',
        gitDeleted: '#ff5555',
        gitUntracked: '#50fa7b',
        gitConflicting: '#ffb86c',
        tabActiveBackground: '#282a36',
        tabActiveForeground: '#f8f8f2',
        tabInactiveBackground: '#21222c',
        tabInactiveForeground: '#6272a4',
        tabHoverBackground: '#343746',
        tabHoverForeground: '#f8f8f2',
        listHoverBackground: '#44475a75',
        listHoverForeground: '#f8f8f2',
        listFocusBackground: '#44475a75',
        listFocusForeground: '#f8f8f2',
        listActiveSelectionBackground: '#44475a',
        listActiveSelectionForeground: '#f8f8f2',
        listInactiveSelectionBackground: '#44475a75',
        listInactiveSelectionForeground: '#f8f8f2',
        titleBarActiveBackground: '#21222c',
        titleBarActiveForeground: '#f8f8f2',
        titleBarInactiveBackground: '#191a21',
        titleBarInactiveForeground: '#6272a4',
        shadow: '#00000073',
    },
    terminal: {
        background: '#282a36',
        foreground: '#f8f8f2',
        cursor: '#f8f8f2',
        selectionBackground: '#44475a',
        black: '#21222c',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#6272a4',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#f8f8f2',
        brightBlack: '#6272a4',
        brightRed: '#ff6e6e',
        brightGreen: '#69ff94',
        brightYellow: '#ffffa5',
        brightBlue: '#d6acff',
        brightMagenta: '#ff92df',
        brightCyan: '#a4ffff',
        brightWhite: '#ffffff',
    },
    editor: {
        background: '#282a36',
        foreground: '#f8f8f2',
        lineHighlight: '#44475a',
        selection: '#44475a',
        comment: '#6272a4',
        keyword: '#ff79c6',
        string: '#f1fa8c',
        number: '#bd93f9',
    },
};

/**
 * VS Code's MIT-licensed Monokai theme, mapped from its workbench, Terminal, and token colors. Source:
 * https://github.com/microsoft/vscode/blob/main/extensions/theme-monokai/themes/monokai-color-theme.json
 */
export const monokaiTheme: ThemeTokens = {
    id: 'monokai',
    name: 'Monokai',
    source: 'builtin',
    colors: {
        background: '#272822',
        surface: '#1e1f1c',
        elevated: '#34352f',
        foreground: '#f8f8f2',
        muted: '#b4b4ad',
        border: '#414339',
        selection: '#414339',
        accent: '#a6e22e',
        success: '#a6e22e',
        warning: '#e6db74',
        danger: '#f92672',
        merged: '#ae81ff',
        /**
         * Monokai sets no `activityBarBadge.background`, so VS Code paints its registry default. Its own
         * `badge.background` (`#75715e`) styles search-result chips, a different control.
         */
        badge: '#007acc',
        gitAdded: '#81b88b',
        gitModified: '#e2c08d',
        gitDeleted: '#c74e39',
        gitUntracked: '#73c991',
        gitConflicting: '#e4676b',
        tabActiveBackground: '#272822',
        tabActiveForeground: '#f8f8f2',
        tabInactiveBackground: '#34352f',
        tabInactiveForeground: '#ccccc7',
        tabHoverBackground: '#34352f',
        tabHoverForeground: '#f8f8f2',
        listHoverBackground: '#3e3d32',
        listHoverForeground: '#f8f8f2',
        listFocusBackground: '#34352f',
        listFocusForeground: '#f8f8f2',
        listActiveSelectionBackground: '#75715e',
        listActiveSelectionForeground: '#f8f8f2',
        listInactiveSelectionBackground: '#414339',
        listInactiveSelectionForeground: '#f8f8f2',
        titleBarActiveBackground: '#1e1f1c',
        titleBarActiveForeground: '#f8f8f2',
        titleBarInactiveBackground: '#202120',
        titleBarInactiveForeground: '#f8f8f2',
        shadow: '#00000098',
    },
    terminal: {
        background: '#272822',
        foreground: '#f8f8f2',
        cursor: '#f8f8f0',
        selectionBackground: '#414339',
        black: '#333333',
        red: '#c4265e',
        green: '#86b42b',
        yellow: '#b3b42b',
        blue: '#6a7ec8',
        magenta: '#8c6bc8',
        cyan: '#56adbc',
        white: '#e3e3dd',
        brightBlack: '#666666',
        brightRed: '#f92672',
        brightGreen: '#a6e22e',
        brightYellow: '#e2e22e',
        brightBlue: '#819aff',
        brightMagenta: '#ae81ff',
        brightCyan: '#66d9ef',
        brightWhite: '#f8f8f2',
    },
    editor: {
        background: '#272822',
        foreground: '#f8f8f2',
        lineHighlight: '#3e3d32',
        selection: '#414339',
        comment: '#88846f',
        keyword: '#f92672',
        string: '#e6db74',
        number: '#ae81ff',
    },
};

/**
 * Binaryify's MIT-licensed One Dark Pro theme. Source:
 * https://github.com/Binaryify/OneDark-Pro/blob/master/themes/OneDark-Pro.json
 */
export const oneDarkProTheme: ThemeTokens = {
    id: 'one-dark-pro',
    name: 'One Dark Pro',
    source: 'builtin',
    colors: {
        background: '#282c34',
        surface: '#21252b',
        elevated: '#2c313a',
        foreground: '#abb2bf',
        muted: '#9da5b4',
        border: '#181a1f',
        selection: '#67769660',
        accent: '#61afef',
        success: '#98c379',
        warning: '#e5c07b',
        danger: '#e06c75',
        merged: '#c678dd',
        badge: '#4d78cc',
        gitAdded: '#81b88b',
        gitModified: '#e2c08d',
        gitDeleted: '#c74e39',
        gitUntracked: '#73c991',
        gitConflicting: '#e4676b',
        tabActiveBackground: '#282c34',
        tabActiveForeground: '#dcdcdc',
        tabInactiveBackground: '#21252b',
        tabInactiveForeground: '#9da5b4',
        tabHoverBackground: '#323842',
        tabHoverForeground: '#abb2bf',
        listHoverBackground: '#2c313a',
        listHoverForeground: '#abb2bf',
        listFocusBackground: '#323842',
        listFocusForeground: '#f0f0f0',
        listActiveSelectionBackground: '#2c313a',
        listActiveSelectionForeground: '#d7dae0',
        listInactiveSelectionBackground: '#323842',
        listInactiveSelectionForeground: '#d7dae0',
        titleBarActiveBackground: '#282c34',
        titleBarActiveForeground: '#9da5b4',
        titleBarInactiveBackground: '#282c34',
        titleBarInactiveForeground: '#6b717d',
        shadow: '#00000073',
    },
    terminal: {
        background: '#282c34',
        foreground: '#abb2bf',
        cursor: '#528bff',
        selectionBackground: '#67769660',
        black: '#3f4451',
        red: '#e05561',
        green: '#8cc265',
        yellow: '#d18f52',
        blue: '#4aa5f0',
        magenta: '#c162de',
        cyan: '#42b3c2',
        white: '#d7dae0',
        brightBlack: '#4f5666',
        brightRed: '#ff616e',
        brightGreen: '#a5e075',
        brightYellow: '#f0a45d',
        brightBlue: '#4dc4ff',
        brightMagenta: '#de73ff',
        brightCyan: '#4cd1e0',
        brightWhite: '#e6e6e6',
    },
    editor: {
        background: '#282c34',
        foreground: '#abb2bf',
        lineHighlight: '#2c313c',
        selection: '#67769660',
        comment: '#7f848e',
        keyword: '#c678dd',
        string: '#98c379',
        number: '#d19a66',
    },
};

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
        gitAdded: '#81b88b',
        gitModified: '#e2c08d',
        gitDeleted: '#c74e39',
        gitUntracked: '#73c991',
        gitConflicting: '#e4676b',
        tabActiveBackground: '#002b37',
        tabActiveForeground: '#d6dbdb',
        tabInactiveBackground: '#004052',
        tabInactiveForeground: '#93a1a1',
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
        tabInactiveForeground: '#586e75',
        tabHoverBackground: '#ddd6c1',
        tabHoverForeground: '#42545a',
        listHoverBackground: '#dfca8844',
        listHoverForeground: '#42545a',
        listFocusBackground: '#ddd6c1',
        listFocusForeground: '#42545a',
        listActiveSelectionBackground: '#dfca88',
        listActiveSelectionForeground: '#6c6c6c',
        listInactiveSelectionBackground: '#d1cbb8',
        listInactiveSelectionForeground: '#6c6c6c',
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
        badge: '#3d59a1',
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
        tabInactiveBackground: '#16161e',
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
        titleBarActiveForeground: '#787c99',
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
        badge: '#e6e7a3',
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
        listHoverBackground: '#ffffff08',
        listHoverForeground: '#e6e6e6',
        listFocusBackground: '#232323',
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

/**
 * VS Code's MIT-licensed Dark+ workbench and syntax theme with its built-in dark Terminal defaults. Sources:
 * https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/dark_plus.json and
 * https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/terminalColorRegistry.ts
 */
export const vscodeDarkPlusTheme: ThemeTokens = {
    id: 'vscode-dark-plus',
    name: 'VS Code Dark+',
    source: 'builtin',
    colors: {
        background: '#1e1e1e',
        surface: '#252526',
        elevated: '#2d2d30',
        foreground: '#d4d4d4',
        muted: '#9d9d9d',
        border: '#303031',
        selection: '#264f78',
        accent: '#007acc',
        success: '#89d185',
        warning: '#cca700',
        danger: '#f48771',
        merged: '#c586c0',
        badge: '#007acc',
        gitAdded: '#81b88b',
        gitModified: '#e2c08d',
        gitDeleted: '#c74e39',
        gitUntracked: '#73c991',
        gitConflicting: '#e4676b',
        tabActiveBackground: '#1e1e1e',
        tabActiveForeground: '#d4d4d4',
        tabInactiveBackground: '#303031',
        tabInactiveForeground: '#a6a6a6',
        tabHoverBackground: '#2d2d30',
        tabHoverForeground: '#d4d4d4',
        /**
         * Dark+ declares its list and tab state colors in VS Code's TypeScript color registry rather than in
         * `dark_plus.json`, so the four list fills below all resolve to `elevated` through the documented fallback —
         * the same result an import of that file produces. Matching the registry would make the preset and an import of
         * its own source disagree.
         */
        listHoverBackground: '#2d2d30',
        listHoverForeground: '#d4d4d4',
        listFocusBackground: '#2d2d30',
        listFocusForeground: '#d4d4d4',
        listActiveSelectionBackground: '#2d2d30',
        listActiveSelectionForeground: '#d4d4d4',
        listInactiveSelectionBackground: '#2d2d30',
        listInactiveSelectionForeground: '#d4d4d4',
        titleBarActiveBackground: '#252526',
        titleBarActiveForeground: '#d4d4d4',
        titleBarInactiveBackground: '#323233',
        titleBarInactiveForeground: '#d4d4d4',
        shadow: '#00000073',
    },
    terminal: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5',
    },
    editor: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        lineHighlight: '#2a2d2e',
        selection: '#264f78',
        comment: '#6a9955',
        keyword: '#c586c0',
        string: '#ce9178',
        number: '#b5cea8',
    },
};

/**
 * Stable user-facing order for the built-in theme picker.
 */
export const builtinThemes = [
    draculaTheme,
    monokaiTheme,
    oneDarkProTheme,
    solarizedDarkTheme,
    solarizedLightTheme,
    tokyoNightTheme,
    oscuraMidnightTheme,
    vscodeDarkPlusTheme,
] as const satisfies readonly ThemeTokens[];

export const builtinThemeIds = [
    'dracula',
    'monokai',
    'one-dark-pro',
    'solarized-dark',
    'solarized-light',
    'tokyo-night',
    'oscura-midnight',
    'vscode-dark-plus',
] as const;

export type BuiltinThemeId = (typeof builtinThemeIds)[number];

export const builtinThemeSources = {
    'dracula': {
        license: 'MIT',
        url: 'https://github.com/dracula/dracula-theme',
    },
    'monokai': {
        license: 'MIT',
        url: 'https://github.com/microsoft/vscode/blob/main/extensions/theme-monokai/themes/monokai-color-theme.json',
    },
    'one-dark-pro': {
        license: 'MIT',
        url: 'https://github.com/Binaryify/OneDark-Pro/blob/master/themes/OneDark-Pro.json',
    },
    'solarized-dark': {
        license: 'MIT',
        url: 'https://github.com/microsoft/vscode/blob/main/extensions/theme-solarized-dark/themes/solarized-dark-color-theme.json',
    },
    'solarized-light': {
        license: 'MIT',
        url: 'https://github.com/microsoft/vscode/blob/main/extensions/theme-solarized-light/themes/solarized-light-color-theme.json',
    },
    'tokyo-night': {
        license: 'MIT',
        url: 'https://github.com/tokyo-night/tokyo-night-vscode-theme/blob/master/themes/tokyo-night-color-theme.json',
    },
    'oscura-midnight': {
        license: 'MIT',
        url: 'https://github.com/narative/oscura/blob/main/themes/oscura-midnight.json',
    },
    'vscode-dark-plus': {
        license: 'MIT',
        url: 'https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/dark_plus.json',
    },
} as const satisfies Record<BuiltinThemeId, { license: 'MIT'; url: string }>;
