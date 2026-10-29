import { useEffect } from 'react';

import { cssFontFamilyEntry } from '@caxri/utils';

import { applyCssTheme } from '../lib/theme-css';
import { useSettings, useTheme } from '../stores/selectors';
import { readSystemColorScheme } from './use-system-color-scheme';

/**
 * Remembers the canvas color painted under the current system appearance so the next launch's startup loader
 * (`renderer/index.html`) can paint it before any bundle has run. It is keyed by appearance because a light-mode launch
 * must not inherit what a dark-mode session painted. Storage can be unavailable; the loader then falls back to its
 * default light canvas.
 */
function rememberStartupBackground(background: string): void {
    try {
        localStorage.setItem(`caxri.startupBackground.${readSystemColorScheme()}`, background);
    } catch {
        // The loader falls back to its default canvas.
    }
}

/**
 * Publishes the Workbench snapshot's theme and font Settings onto the document root. Every window that renders
 * Workbench components (the Workbench itself and Caxri Bot) calls this, so both follow the same Settings the same way.
 */
export function useWorkbenchAppearance(): void {
    const theme = useTheme();
    const workbenchFontFamily = useSettings()?.['workbench.fontFamily'];
    const editorFontFamily = useSettings()?.['editor.fontFamily'];
    useEffect(() => {
        if (!theme) return;
        applyCssTheme(theme);
        rememberStartupBackground(theme.colors.background);
    }, [theme]);
    useEffect(() => {
        const entry = cssFontFamilyEntry(workbenchFontFamily);
        // Keep the default stack behind the custom entry so a missing or misspelled font degrades to the system
        // font instead of the browser serif default (the `var()` fallback in theme.css only applies when unset).
        if (entry)
            document.documentElement.style.setProperty(
                '--workbench-font-family',
                `${entry}, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`,
            );
        else document.documentElement.style.removeProperty('--workbench-font-family');
    }, [workbenchFontFamily]);
    /**
     * Monaco receives `editor.fontFamily` as an option, which reaches nothing outside an editor widget. Publishing it
     * as a custom property too is what lets CSS-rendered code, the Markdown preview's fenced blocks, use the same font
     * as the editor those lines came from.
     */
    useEffect(() => {
        const entry = cssFontFamilyEntry(editorFontFamily);
        if (entry) document.documentElement.style.setProperty('--editor-font-family', entry);
        else document.documentElement.style.removeProperty('--editor-font-family');
    }, [editorFontFamily]);
}
