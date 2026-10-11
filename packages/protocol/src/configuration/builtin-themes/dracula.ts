import type { ThemeTokens } from '../../domain/domain.js';

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
         * Dracula paints every "this is the active one" edge pink (`tab.activeBorderTop`, `activityBar.activeBorder`,
         * and `progressBar.background` are all `#ff79c6`), which is exactly the set `accent` covers here. Its
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
        chart: '#50fa7b',
        badge: '#ff79c6',
        errorBadge: '#ff5555',
        warningBadge: '#f1fa8c',
        gitAdded: '#81b88b',
        gitModified: '#8be9fd',
        gitDeleted: '#ff5555',
        gitUntracked: '#50fa7b',
        gitConflicting: '#ffb86c',
        tabActiveBackground: '#282a36',
        tabActiveForeground: '#f8f8f2',
        tabInactiveBackground: '#21222c',
        /**
         * Dracula's own `tab.inactiveForeground` is the comment blue again (3.36:1 here), so this reuses the adjusted
         * `muted` above rather than the upstream value.
         */
        tabInactiveForeground: '#9aa5c4',
        tabHoverBackground: '#343746',
        tabHoverForeground: '#f8f8f2',
        listHoverBackground: '#44475a75',
        listHoverForeground: '#f8f8f2',
        /**
         * Upstream Dracula gives `list.focusBackground` and `list.hoverBackground` the same `#44475a75`, so the row the
         * keyboard is on and the row the pointer happens to be over paint identically and a keyboard user cannot tell
         * where focus is. VS Code keeps the two apart by weight (a quiet neutral wash for hover against a stronger,
         * outlined fill for focus), so this raises the alpha of the palette's own selection grey instead of inventing a
         * color: hover 46% < focus 75% < `listActiveSelectionBackground` opaque, which keeps the three list states in
         * one ramp and still reads as Dracula.
         */
        listFocusBackground: '#44475abf',
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
