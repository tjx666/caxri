/**
 * VS Code's registry defaults for the workbench colors Caxri maps, used exactly as VS Code uses them: when a theme
 * leaves a key unset, this is the color it actually paints. Seeding an unset role from Dracula instead (the previous
 * behavior for every role below) produced imports that mixed two palettes: a light VS Code theme kept Dracula's dark
 * `elevated`, `muted`, and `selection`. Decoration defaults come from the built-in Git extension's `contributes.colors`
 * rather than the core registry.
 */
export const VSCODE_DEFAULTS = {
    dark: {
        surface: '#252526', // sideBar.background
        elevated: '#252526', // editorWidget.background
        muted: '#9d9d9d', // descriptionForeground
        selection: '#264f78', // editor.selectionBackground
        border: '#454545', // contrastBorder-less panel/tab seam
        success: '#89d185', // testing.iconPassed / notebook success
        warning: '#cca700', // editorWarning.foreground
        danger: '#f48771', // editorError.foreground
        badge: '#007acc', // activityBarBadge.background
        /**
         * `activityErrorBadge`/`activityWarningBadge` are recent keys most themes still leave unset, so these repeat
         * the error and warning foreground defaults above rather than adding a color the theme never declared.
         */
        errorBadge: '#f48771',
        warningBadge: '#cca700',
        gitAdded: '#81b88b',
        gitModified: '#e2c08d',
        gitDeleted: '#c74e39',
        gitUntracked: '#73c991',
        gitConflicting: '#e4676b',
    },
    light: {
        surface: '#f3f3f3', // sideBar.background
        elevated: '#f3f3f3',
        /**
         * VS Code's light `foreground`, not its light `descriptionForeground` (`#717171`): that value lands at 4.4:1 on
         * the light `editorWidget.background` default below, just under the AA floor `assertMutedContrast` holds every
         * import to, so a plain light theme that sets neither key would be rejected outright.
         */
        muted: '#616161',
        selection: '#add6ff',
        border: '#c8c8c8',
        success: '#2d883e',
        warning: '#bf8803',
        danger: '#e51400',
        badge: '#007acc',
        errorBadge: '#e51400',
        warningBadge: '#bf8803',
        gitAdded: '#587c0c',
        gitModified: '#895503',
        gitDeleted: '#ad0707',
        gitUntracked: '#007100',
        gitConflicting: '#ad0707',
    },
} as const;
