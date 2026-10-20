import { relativeLuminance } from '@caxri/utils';

/**
 * The midpoint of WCAG relative luminance is far brighter than a perceptual midpoint, so `0.18` (mid-grey) splits the
 * built-in and imported themes the way a person would call them light or dark.
 */
const isDarkColor = (hex: string): boolean => relativeLuminance(hex) < 0.18;

/**
 * Whether the primary sidebar lets the window's macOS `vibrancy` material show through. The material follows the system
 * appearance, not the theme (see `window-chrome.ts`), so a dark theme over a light system blurs a white sheet behind
 * the sidebar and washes it out; the sidebar stays opaque until the two agree. Other platforms have no material.
 */
export function isTranslucentSidebarActive(input: {
    isMacOS: boolean;
    isEnabled: boolean;
    themeBackground: string | undefined;
    isSystemDark: boolean;
}): boolean {
    if (!input.isMacOS || !input.isEnabled || !input.themeBackground) return false;
    return isDarkColor(input.themeBackground) === input.isSystemDark;
}
