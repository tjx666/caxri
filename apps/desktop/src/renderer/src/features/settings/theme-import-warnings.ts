/**
 * Warning dismissals belong to the current renderer session, not to serialized theme.json.
 */
const dismissalsByTheme = new Map<string, ReadonlySet<string>>();
const generationsByTheme = new Map<string, number>();

export function readThemeImportWarningDismissals(themeId: string): ReadonlySet<string> {
    return dismissalsByTheme.get(themeId) ?? new Set();
}

export function dismissThemeImportWarning(themeId: string, warning: string): void {
    const next = new Set(readThemeImportWarningDismissals(themeId));
    next.add(warning);
    dismissalsByTheme.set(themeId, next);
}

export function resetThemeImportWarningDismissals(themeId: string): void {
    dismissalsByTheme.delete(themeId);
    generationsByTheme.set(themeId, themeImportWarningDismissGeneration(themeId) + 1);
}

export function themeImportWarningDismissGeneration(themeId: string): number {
    return generationsByTheme.get(themeId) ?? 0;
}
