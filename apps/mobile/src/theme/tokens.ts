import { draculaTheme } from '@caxri/protocol';

export interface MobileTheme {
    background: string;
    border: string;
    danger: string;
    muted: string;
    primary: string;
    primaryForeground: string;
    surface: string;
    text: string;
}

/**
 * Phase one deliberately shares Desktop's canonical Dracula palette. Keeping the semantic mapping here preserves a
 * single mobile theme entry point while appearance modes remain a later product decision.
 */
export const mobileTheme = {
    background: draculaTheme.colors.background,
    border: draculaTheme.colors.border,
    danger: draculaTheme.colors.danger,
    muted: draculaTheme.colors.muted,
    primary: draculaTheme.colors.accent,
    primaryForeground: draculaTheme.colors.background,
    surface: draculaTheme.colors.surface,
    text: draculaTheme.colors.foreground,
} as const satisfies MobileTheme;
