import { useEffect } from 'react';

import { defaultAppSettings } from '@caxri/protocol';

import { useSystemColorScheme } from '../../../hooks/use-system-color-scheme';
import { useIsFullScreen, useSettings, useTheme } from '../../../stores/selectors';
import type { TranslucentSidebarInput } from '../translucent-sidebar';
import { isTranslucentSidebarActive } from '../translucent-sidebar';

/**
 * Electron's Chromium reports `Macintosh` in every macOS user agent; the Renderer has no other platform signal.
 */
const isMacOS = navigator.userAgent.includes('Macintosh');

/**
 * The live inputs of the frosted sidebar: the Setting, the theme, the system appearance, and the window's full-screen
 * state. Shared by the root-attribute hook and the Settings row that explains an inactive Setting.
 */
export function useTranslucentSidebarInput(): TranslucentSidebarInput {
    const themeBackground = useTheme()?.colors.background;
    const isEnabled =
        useSettings()?.['primarySidebar.translucent'] ??
        defaultAppSettings['primarySidebar.translucent'];
    const isSystemDark = useSystemColorScheme() === 'dark';
    const isFullScreen = useIsFullScreen();
    return { isMacOS, isEnabled, themeBackground, isSystemDark, isFullScreen };
}

/**
 * Marks the document root with `data-translucent-sidebar` while the frosted sidebar applies, re-evaluated when the
 * theme, the Setting, the system appearance, or full screen changes. Only the main window has the `vibrancy` material,
 * so only the Workbench calls this.
 */
export function useTranslucentSidebar(): void {
    const isActive = isTranslucentSidebarActive(useTranslucentSidebarInput());
    useEffect(() => {
        document.documentElement.toggleAttribute('data-translucent-sidebar', isActive);
    }, [isActive]);
}
