import { draculaTheme } from '@caxri/protocol';

export interface MobileTheme {
    background: string;
    border: string;
    danger: string;
    /**
     * Raised controls and pills that sit on `surface`.
     */
    elevated: string;
    /**
     * Landed work, such as a merged pull request, matching Desktop's `merged` token.
     */
    merged: string;
    muted: string;
    primary: string;
    primaryForeground: string;
    success: string;
    surface: string;
    text: string;
    /**
     * Unread attention, matching Desktop's amber attention slot.
     */
    warning: string;
}

/**
 * Phase one deliberately shares Desktop's canonical Dracula palette. Keeping the semantic mapping here preserves a
 * single mobile theme entry point while appearance modes remain a later product decision.
 */
export const mobileTheme = {
    background: draculaTheme.colors.background,
    border: draculaTheme.colors.border,
    danger: draculaTheme.colors.danger,
    elevated: draculaTheme.colors.elevated,
    merged: draculaTheme.colors.merged,
    muted: draculaTheme.colors.muted,
    primary: draculaTheme.colors.accent,
    primaryForeground: draculaTheme.colors.background,
    success: draculaTheme.colors.success,
    surface: draculaTheme.colors.surface,
    text: draculaTheme.colors.foreground,
    warning: draculaTheme.colors.warning,
} as const satisfies MobileTheme;
