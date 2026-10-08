/**
 * Virtual editor tab that renders the Settings surface. Settings has no source path and only one occurrence identity
 * (unlike a Git diff or a file preview, there is nothing to encode), so the path is a fixed constant rather than a
 * template. It still rides on the ordinary `{kind: 'file', path}` `PaneResource`, so Settings opens, closes, and
 * duplicates across panes exactly like any other document tab, with no protocol change.
 */
const SETTINGS_TAB_PATH = 'caxri-settings://workbench';

export function settingsTabPath(): string {
    return SETTINGS_TAB_PATH;
}

export function isSettingsTabPath(tabPath: string): boolean {
    return tabPath === SETTINGS_TAB_PATH;
}

export const SETTINGS_TAB_LABEL = 'Settings';
