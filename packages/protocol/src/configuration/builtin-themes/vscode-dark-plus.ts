import type { ThemeTokens } from '../../domain/domain.js';

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
        errorBadge: '#f48771',
        warningBadge: '#cca700',
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
         * Dark+ declares its list state colors in VS Code's TypeScript color registry rather than in `dark_plus.json`,
         * so the four fills below come from the importer's fallback rather than from that file. They used to collapse
         * onto one `elevated` grey, which left hover, keyboard focus, and selection indistinguishable; the fallback now
         * reproduces the registry's own values, so the preset and an import of Dark+'s own source still agree. See
         * `listStateDefaults` in `apps/server/src/domains/theme/theme-colors.ts` and issue #1006.
         */
        listHoverBackground: '#2a2d2e',
        listHoverForeground: '#d4d4d4',
        listFocusBackground: '#04395e59',
        listFocusForeground: '#d4d4d4',
        listActiveSelectionBackground: '#04395e',
        listActiveSelectionForeground: '#ffffff',
        listInactiveSelectionBackground: '#37373d',
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
