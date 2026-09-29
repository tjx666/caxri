import type { ThemeTokens } from '@caxri/protocol';
import { diffStatColors, themeColorCssVariable } from '@caxri/protocol';
import { contrastRatio } from '@caxri/utils';

const MIN_TEXT_CONTRAST = 4.5;

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
    const diffStat = diffStatColors(theme.colors.success, theme.colors.danger);
    root.style.setProperty('--diff-stat-added', diffStat.added);
    root.style.setProperty('--diff-stat-removed', diffStat.removed);
}
