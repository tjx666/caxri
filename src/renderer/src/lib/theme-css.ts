import type { ThemeTokens } from '@shared/types';

export function applyCssTheme(theme: ThemeTokens): void {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(theme.colors))
        root.style.setProperty(`--${key}`, value);
}
