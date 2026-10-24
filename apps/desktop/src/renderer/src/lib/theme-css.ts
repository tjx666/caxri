import type { ThemeTokens } from '@caxri/protocol';
import { diffStatColors, themeColorCssVariable } from '@caxri/protocol';
import { contrastRatio } from '@caxri/utils';

const MIN_TEXT_CONTRAST = 4.5;
const MIN_GRAPHIC_CONTRAST = 3;

/**
 * Prefers theme-native foregrounds, then falls back to white or black when a fill sits between the theme's light and
 * dark poles. This keeps button, checkbox, and switch glyphs readable for light themes without adding presentation-only
 * colors to the persisted theme contract.
 */
function readableForeground(fill: string, theme: ThemeTokens): string {
    const candidates = [theme.colors.background, theme.colors.foreground, '#ffffff', '#000000'];
    return (
        candidates.find((candidate) => contrastRatio(fill, candidate) >= MIN_TEXT_CONTRAST) ??
        '#000000'
    );
}

/**
 * Picks a fill for a non-text graphic (a Switch thumb) over `fill`. Graphics only need WCAG's 3:1 non-text contrast, so
 * `readableForeground`'s 4.5:1 text threshold would reject a theme's own canvas color on a mid-tone accent (Solarized
 * Light: 2.98:1) and fall through to pure black. Prefer the theme's colors, then white, and only then the strongest
 * candidate.
 */
function graphicFill(fill: string, theme: ThemeTokens, preferred: string[]): string {
    const candidates = [...preferred, '#ffffff', theme.colors.foreground, '#000000'];
    return (
        candidates.find((candidate) => contrastRatio(fill, candidate) >= MIN_GRAPHIC_CONTRAST) ??
        candidates.reduce((best, candidate) =>
            contrastRatio(fill, candidate) > contrastRatio(fill, best) ? candidate : best,
        )
    );
}

export function applyCssTheme(theme: ThemeTokens): void {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(theme.colors))
        root.style.setProperty(themeColorCssVariable(key), value);
    root.style.setProperty('--accent-foreground', readableForeground(theme.colors.accent, theme));
    root.style.setProperty('--danger-foreground', readableForeground(theme.colors.danger, theme));
    root.style.setProperty('--badge-foreground', readableForeground(theme.colors.badge, theme));
    root.style.setProperty(
        '--error-badge-foreground',
        readableForeground(theme.colors.errorBadge, theme),
    );
    root.style.setProperty(
        '--warning-badge-foreground',
        readableForeground(theme.colors.warningBadge, theme),
    );
    root.style.setProperty(
        '--switch-thumb',
        graphicFill(theme.colors.accent, theme, [theme.colors.background]),
    );
    root.style.setProperty(
        '--switch-thumb-off',
        graphicFill(theme.colors.border, theme, [theme.colors.foreground]),
    );
    const diffStat = diffStatColors(theme.colors.success, theme.colors.danger);
    root.style.setProperty('--diff-stat-added', diffStat.added);
    root.style.setProperty('--diff-stat-removed', diffStat.removed);
}
