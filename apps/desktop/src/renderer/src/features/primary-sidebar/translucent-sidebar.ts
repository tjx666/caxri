import { relativeLuminance } from '@caxri/utils';

/**
 * The midpoint of WCAG relative luminance is far brighter than a perceptual midpoint, so `0.18` (mid-grey) splits the
 * built-in and imported themes the way a person would call them light or dark.
 */
const isDarkColor = (hex: string): boolean => relativeLuminance(hex) < 0.18;

/**
 * What {@link isTranslucentSidebarActive} reads.
 */
export interface TranslucentSidebarInput {
    isMacOS: boolean;
    isEnabled: boolean;
    themeBackground: string | undefined;
    isSystemDark: boolean;
    /**
     * The window is in macOS full screen, where nothing sits behind it for the material to blur.
     */
    isFullScreen: boolean;
}

/**
 * Whether the primary sidebar lets the window's macOS `vibrancy` material show through. The material follows the system
 * appearance, not the theme (see `window-chrome.ts`), so a dark theme over a light system blurs a white sheet behind
 * the sidebar and washes it out; the sidebar stays opaque until the two agree. A full-screen window has no desktop
 * behind it, so the material would only show a flat grey sheet and the sidebar stays opaque there too. Other platforms
 * have no material.
 */
export function isTranslucentSidebarActive(input: TranslucentSidebarInput): boolean {
    if (!input.isMacOS || !input.isEnabled || !input.themeBackground || input.isFullScreen)
        return false;
    return isDarkColor(input.themeBackground) === input.isSystemDark;
}

/**
 * Why the Setting is on but the sidebar is opaque, so its Settings row can say so instead of looking broken. Undefined
 * when the sidebar is frosted, or when the Setting is off or does not apply here (no explanation owed).
 */
export type TranslucentSidebarInactiveReason =
    'fullScreen' | 'themeDarkSystemLight' | 'themeLightSystemDark';

export function translucentSidebarInactiveReason(
    input: TranslucentSidebarInput,
): TranslucentSidebarInactiveReason | undefined {
    if (!input.isMacOS || !input.isEnabled || !input.themeBackground) return undefined;
    if (input.isFullScreen) return 'fullScreen';
    if (isTranslucentSidebarActive(input)) return undefined;
    return input.isSystemDark ? 'themeLightSystemDark' : 'themeDarkSystemLight';
}
