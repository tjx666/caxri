import type { ThemeTokens } from '../domain/domain.js';
import { themeTokensSchema } from '../domain/domain.js';
import { builtinThemes } from './builtin-themes/catalog.js';

/**
 * The popup shadow a theme gets when it names no `widget.shadow`. `73` is 45% alpha, which is the value
 * `styles/theme.css` hardcoded before the role became themeable, so an existing theme's popups are unchanged.
 */
export const DEFAULT_SHADOW = '#00000073';

/**
 * CSS custom property for a theme color role. Roles are camelCase in the persisted contract and kebab-case in the
 * stylesheet, so `gitAdded` reaches the Renderer as `--git-added`. Shared rather than inlined because `applyCssTheme`
 * writes these names at runtime and `styles/theme.css` hardcodes the same ones as its pre-Runtime fallback; the two are
 * asserted equal, and a private copy of the rule on either side would let them drift into a first-frame flash.
 */
export function themeColorCssVariable(role: string): string {
    return `--${role.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/**
 * Every color role added after the first release, newest group last. A saved theme file missing any of these predates
 * the release that introduced it.
 */
const UPGRADABLE_COLOR_ROLES = [
    'merged',
    'badge',
    'gitAdded',
    'gitModified',
    'gitDeleted',
    'gitUntracked',
    'gitConflicting',
    'errorBadge',
    'warningBadge',
    'tabActiveBackground',
    'tabActiveForeground',
    'tabInactiveBackground',
    'tabInactiveForeground',
    'tabHoverBackground',
    'tabHoverForeground',
    'listHoverBackground',
    'listHoverForeground',
    'listFocusBackground',
    'listFocusForeground',
    'listActiveSelectionBackground',
    'listActiveSelectionForeground',
    'listInactiveSelectionBackground',
    'listInactiveSelectionForeground',
    'titleBarActiveBackground',
    'titleBarActiveForeground',
    'titleBarInactiveBackground',
    'titleBarInactiveForeground',
    'shadow',
    'chart',
] as const satisfies ReadonlyArray<keyof ThemeTokens['colors']>;

/**
 * Where a custom theme, which has no catalog entry to recover from, borrows each late role. Every source is a role the
 * file already carries, so the recovered value is readable on that theme's own surfaces by construction. Falling back
 * to `accent` for all of them was tried first and is wrong for the decorations: it paints added, deleted, and
 * conflicting files the same color, which is exactly the distinction the roles exist to make.
 */
const CUSTOM_THEME_ROLE_SOURCE = {
    merged: 'accent',
    badge: 'accent',
    gitAdded: 'success',
    gitModified: 'warning',
    gitDeleted: 'danger',
    gitUntracked: 'success',
    gitConflicting: 'danger',
    /**
     * The severity fills borrow the severity text colors a theme already carries. Not ideal (those are tuned for text
     * on the canvas rather than as a fill), but it is the only value in the file that means the same thing, and the
     * badge derives its own readable foreground on top of whatever it gets.
     */
    errorBadge: 'danger',
    warningBadge: 'warning',
    /**
     * The tab, list, and title-bar roles borrow the same surfaces those controls were painted with before the roles
     * existed, so a file written by the older build keeps the exact appearance it had. `shadow` is the one value with
     * no earlier role to recover: the stylesheet's own 45% black is what it used to be.
     */
    tabActiveBackground: 'background',
    tabActiveForeground: 'foreground',
    tabInactiveBackground: 'surface',
    tabInactiveForeground: 'muted',
    tabHoverBackground: 'elevated',
    tabHoverForeground: 'foreground',
    listHoverBackground: 'elevated',
    listHoverForeground: 'foreground',
    listFocusBackground: 'elevated',
    listFocusForeground: 'foreground',
    listActiveSelectionBackground: 'elevated',
    listActiveSelectionForeground: 'foreground',
    listInactiveSelectionBackground: 'elevated',
    listInactiveSelectionForeground: 'foreground',
    titleBarActiveBackground: 'surface',
    titleBarActiveForeground: 'foreground',
    titleBarInactiveBackground: 'surface',
    titleBarInactiveForeground: 'foreground',
    /**
     * Charts painted `success` before the role existed, so a custom theme keeps the chart color it had.
     */
    chart: 'success',
} as const satisfies Record<
    Exclude<(typeof UPGRADABLE_COLOR_ROLES)[number], 'shadow'>,
    keyof ThemeTokens['colors']
>;

/**
 * Late roles with no earlier role to borrow from, and the value to write instead. `shadow` existed only as a hardcoded
 * stylesheet value, so recovering it means restating that value rather than pointing at another role.
 */
const CUSTOM_THEME_ROLE_LITERAL = {
    shadow: DEFAULT_SHADOW,
} as const satisfies Partial<Record<(typeof UPGRADABLE_COLOR_ROLES)[number], string>>;

/**
 * Fills in color roles that did not exist when a theme file was written, ahead of schema validation.
 *
 * A fixed default hex cannot do this job. `findMatchingBuiltinTheme` compares the whole parsed snapshot, so filling
 * `merged` with any value other than the preset's own would strip a saved preset's built-in identity;
 * `normalizeBuiltinTheme` would then rewrite it to `custom-*` and `ConfigService` would persist that downgrade. A
 * single default is also wrong on contrast grounds: no one violet clears 3:1 on both a dark and a light preset's
 * chrome. Recovering the preset's own value keeps identity and contrast intact. A genuinely custom theme has no catalog
 * entry to recover from and borrows the nearest role it already carries (see {@link CUSTOM_THEME_ROLE_SOURCE}).
 *
 * A built-in theme follows the app's catalog when a release adds a color role: a `source: 'builtin'` snapshot missing
 * any of these roles gets its whole `colors` block replaced by the catalog's, not just the absent keys. Settings save a
 * full snapshot of the chosen preset, and a release that adds a role often retunes existing ones too; backfilling only
 * the new keys would leave the preset failing `findMatchingBuiltinTheme`, silently downgrading the user to `custom-*`
 * and pinning them to the old colors. This is a standing product behavior, not a compatibility path for unpublished
 * builds (issue #2604): it fires again on every release that adds a role. A retune that adds no role is not followed;
 * that snapshot is demoted to `custom-*` by `normalizeBuiltinTheme`.
 *
 * Anything that is not a theme-shaped object passes through untouched so the schema still owns rejection.
 */
export function upgradeThemeColors(value: unknown): unknown {
    if (typeof value !== 'object' || value === null) return value;
    const theme = value as { colors?: unknown; id?: unknown; source?: unknown };
    const colors = theme.colors;
    if (typeof colors !== 'object' || colors === null) return value;
    const missing = UPGRADABLE_COLOR_ROLES.filter((role) => !(role in colors));
    if (missing.length === 0) return value;
    const preset = builtinThemes.find((candidate) => candidate.id === theme.id);
    if (preset && theme.source === 'builtin')
        return { ...theme, colors: structuredClone(preset.colors) };
    const existing = colors as Record<string, unknown>;
    const recovered: Record<string, unknown> = { ...existing };
    for (const role of missing) {
        const value_ =
            preset?.colors[role] ??
            (role in CUSTOM_THEME_ROLE_LITERAL
                ? CUSTOM_THEME_ROLE_LITERAL[role as keyof typeof CUSTOM_THEME_ROLE_LITERAL]
                : existing[
                      CUSTOM_THEME_ROLE_SOURCE[role as keyof typeof CUSTOM_THEME_ROLE_SOURCE]
                  ]);
        if (typeof value_ !== 'string') return value;
        recovered[role] = value_;
    }
    return { ...theme, colors: recovered };
}

/**
 * Finds a preset only when every persisted token still matches the current built-in snapshot.
 */
export function findMatchingBuiltinTheme(theme: ThemeTokens): ThemeTokens | undefined {
    const canonicalTheme = JSON.stringify(themeTokensSchema.parse(theme));
    return builtinThemes.find(
        (candidate) => JSON.stringify(themeTokensSchema.parse(candidate)) === canonicalTheme,
    );
}

/**
 * Keeps externally edited built-in snapshots honest after a restart.
 */
export function normalizeBuiltinTheme(theme: ThemeTokens): ThemeTokens {
    if (theme.source !== 'builtin' || findMatchingBuiltinTheme(theme)) return theme;
    return {
        ...theme,
        id: theme.id.startsWith('custom-') ? theme.id : `custom-${theme.id}`,
        source: 'custom',
    };
}
