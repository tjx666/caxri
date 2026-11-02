/**
 * Where an imported theme is in use right now: as the single saved theme, or as the light or dark slot of "Follow
 * system appearance".
 */
export type ImportedThemeUse = 'current' | 'light' | 'dark';

export interface ImportedThemeUsageInput {
    /**
     * `theme.id` of the saved single theme (`theme.json`).
     */
    currentThemeId: string;
    isFollowingSystem: boolean;
    lightThemeId: string;
    darkThemeId: string;
}

/**
 * The ways `themeId` is in use. While following the system only the two slots paint; otherwise only the saved theme
 * paints, so the slot ids kept in settings for later do not count.
 */
export function importedThemeUses(
    themeId: string,
    input: ImportedThemeUsageInput,
): ImportedThemeUse[] {
    if (!input.isFollowingSystem) return input.currentThemeId === themeId ? ['current'] : [];
    const uses: ImportedThemeUse[] = [];
    if (input.lightThemeId === themeId) uses.push('light');
    if (input.darkThemeId === themeId) uses.push('dark');
    return uses;
}
