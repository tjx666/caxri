import type { ThemeTokens } from '../../domain/domain.js';

/**
 * VS Code's MIT-licensed Light+ workbench and syntax theme with its built-in light Terminal defaults. Sources:
 * https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/light_plus.json and
 * https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/terminalColorRegistry.ts
 *
 * This is the conventional light preset that "Follow system appearance" pairs with Dracula. Where Light+ misses WCAG AA
 * on its own white canvas (its Terminal yellow, green, and cyan sit near 2.5:1 to 3.7:1), the ANSI hue is kept and
 * darkened until it reads, as `solarizedLightTheme` does.
 */
export const vscodeLightPlusTheme: ThemeTokens = {
    id: 'vscode-light-plus',
    name: 'VS Code Light+',
    source: 'builtin',
    colors: {
        background: '#ffffff',
        surface: '#f3f3f3',
        elevated: '#e8e8e8',
        /**
         * Light+ paints UI text `#616161`; the darker `#333333` keeps primary text well past AA on all three surfaces
         * and leaves `muted` a visible step below it.
         */
        foreground: '#333333',
        muted: '#5f5f5f',
        border: '#d4d4d4',
        selection: '#add6ff',
        accent: '#007acc',
        success: '#388a34',
        warning: '#9a6700',
        danger: '#c72e0f',
        merged: '#8250df',
        chart: '#388a34',
        badge: '#007acc',
        errorBadge: '#c72e0f',
        warningBadge: '#9a6700',
        /**
         * The Git extension's light-variant defaults, as in Solarized Light.
         */
        gitAdded: '#587c0c',
        gitModified: '#895503',
        gitDeleted: '#ad0707',
        gitUntracked: '#007100',
        gitConflicting: '#ad0707',
        tabActiveBackground: '#ffffff',
        tabActiveForeground: '#333333',
        tabInactiveBackground: '#ececec',
        tabInactiveForeground: '#616161',
        tabHoverBackground: '#e4e4e4',
        tabHoverForeground: '#333333',
        listHoverBackground: '#e8e8e8',
        listHoverForeground: '#333333',
        listFocusBackground: '#d6ebff',
        listFocusForeground: '#333333',
        listActiveSelectionBackground: '#0060c0',
        listActiveSelectionForeground: '#ffffff',
        listInactiveSelectionBackground: '#e4e6f1',
        listInactiveSelectionForeground: '#333333',
        titleBarActiveBackground: '#ececec',
        titleBarActiveForeground: '#333333',
        titleBarInactiveBackground: '#f3f3f3',
        titleBarInactiveForeground: '#616161',
        shadow: '#00000029',
    },
    terminal: {
        background: '#ffffff',
        foreground: '#333333',
        cursor: '#333333',
        selectionBackground: '#add6ff',
        black: '#000000',
        red: '#cd3131',
        green: '#107c10',
        yellow: '#7d6400',
        blue: '#0451a5',
        magenta: '#bc05bc',
        cyan: '#0a7f9c',
        white: '#555555',
        brightBlack: '#666666',
        brightRed: '#cd3131',
        brightGreen: '#0f8a0f',
        brightYellow: '#8f6700',
        brightBlue: '#0b5cb8',
        brightMagenta: '#a626a4',
        brightCyan: '#06758f',
        brightWhite: '#a5a5a5',
    },
    editor: {
        background: '#ffffff',
        foreground: '#000000',
        lineHighlight: '#f0f4fa',
        selection: '#add6ff',
        comment: '#008000',
        keyword: '#0000ff',
        string: '#a31515',
        number: '#098658',
    },
};
