/**
 * Virtual editor tab that renders the Usage report. Like Settings it has a single occurrence identity, so the path is a
 * fixed constant riding on the ordinary `{kind: 'file', path}` `PaneResource`.
 */
const USAGE_TAB_PATH = 'caxri-usage://workbench';

export function usageTabPath(): string {
    return USAGE_TAB_PATH;
}

export function isUsageTabPath(tabPath: string): boolean {
    return tabPath === USAGE_TAB_PATH;
}

export const USAGE_TAB_LABEL = 'Usage';
