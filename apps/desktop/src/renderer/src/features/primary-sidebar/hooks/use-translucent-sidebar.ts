import { useEffect, useSyncExternalStore } from 'react';

import { defaultAppSettings } from '@caxri/protocol';

import { useSettings, useTheme } from '../../../stores/selectors';
import { isTranslucentSidebarActive } from '../translucent-sidebar';

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

const subscribeSystemAppearance = (onChange: () => void): (() => void) => {
    const query = matchMedia(SYSTEM_DARK_QUERY);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
};
const isSystemDark = (): boolean => matchMedia(SYSTEM_DARK_QUERY).matches;

/**
 * Electron's Chromium reports `Macintosh` in every macOS user agent; the Renderer has no other platform signal.
 */
const isMacOS = navigator.userAgent.includes('Macintosh');

/**
 * Marks the document root with `data-translucent-sidebar` while the frosted sidebar applies, re-evaluated when the
 * theme, the Setting, or the system appearance changes. Only the main window has the `vibrancy` material, so only the
 * Workbench calls this.
 */
export function useTranslucentSidebar(): void {
    const themeBackground = useTheme()?.colors.background;
    const isEnabled =
        useSettings()?.['primarySidebar.translucent'] ??
        defaultAppSettings['primarySidebar.translucent'];
    const systemDark = useSyncExternalStore(subscribeSystemAppearance, isSystemDark);
    const isActive = isTranslucentSidebarActive({
        isMacOS,
        isEnabled,
        themeBackground,
        isSystemDark: systemDark,
    });
    useEffect(() => {
        document.documentElement.toggleAttribute('data-translucent-sidebar', isActive);
    }, [isActive]);
}
