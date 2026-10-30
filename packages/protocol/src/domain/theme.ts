import { z } from 'zod';

import { hexColorSchema } from './color.js';

const hex = hexColorSchema;

/**
 * Import-format ids only. `builtin` and `custom` are persistence sources, not import formats: they stay off this list
 * so a new parser must extend both this tuple and `themeTokenSourceIds`.
 */
export const themeImportFormatIds = ['iterm2', 'warp', 'vscode'] as const;
export type ThemeImportFormatId = (typeof themeImportFormatIds)[number];

export const themeTokenSourceIds = ['builtin', 'custom', ...themeImportFormatIds] as const;

export const themeTokensSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    source: z.enum(themeTokenSourceIds),
    colors: z.object({
        background: hex,
        surface: hex,
        elevated: hex,
        foreground: hex,
        muted: hex,
        border: hex,
        selection: hex,
        accent: hex,
        success: hex,
        warning: hex,
        danger: hex,
        merged: hex, // landed work; DESIGN.md owns the role, `upgradeThemeColors` backfills older files
        /**
         * Data-series fill for quantity charts (the Usage heatmap, trend line, and share bars), mirroring VS Code's
         * `charts.green`. A role of its own rather than a reuse of `success` so a theme can retune status green without
         * repainting charts, and so a chart does not read as "passed". Built-in themes seed it with their `success`
         * value, which keeps their charts unchanged.
         */
        chart: hex,
        /**
         * Numeric view-container badge fill, mirroring VS Code's `activityBarBadge.background`. Its text color is
         * derived for contrast rather than persisted, like `accent` and `danger`.
         */
        badge: hex,
        /**
         * Fills for the severity variants of the same badge, mirroring VS Code's `activityErrorBadge.background` and
         * `activityWarningBadge.background`. Separate roles rather than reuses of `danger` and `warning`: those two are
         * text colors tuned to sit on the editor canvas (they import from `editorError.foreground` /
         * `editorWarning.foreground`), and a color that reads as a squiggle is not automatically a readable fill behind
         * a 10px digit.
         */
        errorBadge: hex,
        warningBadge: hex,
        /**
         * Working-tree decoration colors, mirroring VS Code's `gitDecoration.*` resource foregrounds. A theme that
         * leaves one unset inherits the built-in Git extension's default, so every built-in below carries the exact
         * color VS Code would paint. `renamed` shares `gitUntracked` (VS Code's two defaults are the same green) and
         * `ignored` stays on `muted`, so neither needs a role of its own.
         */
        gitAdded: hex,
        gitModified: hex,
        gitDeleted: hex,
        gitUntracked: hex,
        gitConflicting: hex,
        /**
         * Tab, list, and title-bar state fills and text, mirroring VS Code's `tab.*`, `list.*`, and `titleBar.*` keys.
         *
         * These three controls used to borrow `background` / `surface` / `elevated`, which silently dropped every
         * `tab.*` and `list.*` key an imported theme supplied. They cannot simply be folded back into those roles:
         * `elevated` also paints popups, so a list-selection color assigned to it would repaint every popup in the
         * Workbench.
         *
         * The state names carry VS Code's meanings, which are not interchangeable. A list is `active` when it holds
         * keyboard focus; a title bar is `active` when the _window_ is. `titleBar*` is for the title and drag region
         * only: the root tab bar happens to be draggable, which is not a reason to paint tabs with it.
         *
         * A theme that supplies none of these gets each role's documented fallback from the roles resolved in the same
         * import. Nothing falls back onto `background` / `surface` / `elevated` in reverse, and an explicit value is
         * kept exactly as written even when it equals another role's, a theme painting its active tab the editor color
         * is stating a preference, not making a mistake to correct.
         */
        tabActiveBackground: hex,
        tabActiveForeground: hex,
        tabInactiveBackground: hex,
        tabInactiveForeground: hex,
        tabHoverBackground: hex,
        tabHoverForeground: hex,
        listHoverBackground: hex,
        listHoverForeground: hex,
        listFocusBackground: hex,
        listFocusForeground: hex,
        listActiveSelectionBackground: hex,
        listActiveSelectionForeground: hex,
        listInactiveSelectionBackground: hex,
        listInactiveSelectionForeground: hex,
        titleBarActiveBackground: hex,
        titleBarActiveForeground: hex,
        titleBarInactiveBackground: hex,
        titleBarInactiveForeground: hex,
        /**
         * Drop shadow under popups and other raised surfaces, from VS Code's `widget.shadow`. The role already existed
         * as a fixed 45% black in the stylesheet; persisting it is what lets an imported theme move it. A theme setting
         * it fully transparent is turning shadows off, which is honored rather than replaced by the default.
         */
        shadow: hex,
    }),
    terminal: z.object({
        background: hex,
        foreground: hex,
        cursor: hex,
        selectionBackground: hex,
        black: hex,
        red: hex,
        green: hex,
        yellow: hex,
        blue: hex,
        magenta: hex,
        cyan: hex,
        white: hex,
        brightBlack: hex,
        brightRed: hex,
        brightGreen: hex,
        brightYellow: hex,
        brightBlue: hex,
        brightMagenta: hex,
        brightCyan: hex,
        brightWhite: hex,
    }),
    editor: z.object({
        background: hex,
        foreground: hex,
        lineHighlight: hex,
        selection: hex,
        comment: hex,
        keyword: hex,
        string: hex,
        number: hex,
    }),
});

/**
 * Import diagnostics are transient and never part of a saved theme.
 */
export const themeImportWarningSchema = z.object({
    id: z.string().min(1),
    message: z.string().min(1),
});

export type ThemeTokens = z.infer<typeof themeTokensSchema>;
export type ThemeImportWarning = z.infer<typeof themeImportWarningSchema>;
