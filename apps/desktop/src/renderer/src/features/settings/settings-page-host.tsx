import { lazy, Suspense, useState } from 'react';

import { SurfaceErrorBoundary } from '../../components/surface-error-boundary';
import { cn } from '../../lib/utilities';
import { useDialogStore } from '../../stores/dialogs';
import { useSettingsPageSelectionClose } from './settings-page-selection';

/**
 * Lazy so a window that never opens Settings does not load the config-editing form tree, the theme editor, and the
 * keybindings table.
 */
const SettingsWorkbenchPage = lazy(async () => {
    const module = await import('./settings-workbench-page');
    return { default: module.SettingsWorkbenchPage };
});

/**
 * The window-level Settings page (issue #2369). It covers the Workbench column and the Secondary Side Bar, which stay
 * mounted underneath, and never enters a Session's pane layout, so Settings follows the window rather than whichever
 * Session happened to be selected when it opened.
 *
 * Mounted on the first open and kept mounted (hidden, with its layout kept; see `styles.css`) after closing: a Source
 * view draft that cannot be saved yet survives the close instead of being thrown away, and reopening is instant.
 */
export function SettingsPageHost({ className }: { className?: string }) {
    const isOpen = useDialogStore((state) => state.settingsPageOpen);
    const [hasOpened, setHasOpened] = useState(isOpen);
    if (isOpen && !hasOpened) setHasOpened(true);
    useSettingsPageSelectionClose();
    if (!hasOpened) return null;
    return (
        <div
            className={cn('settings-page-host absolute inset-0 z-10 bg-background', className)}
            hidden={!isOpen}
        >
            {/* Its own scope: this outer boundary only catches a failed page load, and sharing `settings` with the
                content boundary inside would let it claim an injected Settings fault before the content does. */}
            <SurfaceErrorBoundary resetKey="settings-page" scope="settings-page">
                <Suspense fallback={null}>
                    <SettingsWorkbenchPage />
                </Suspense>
            </SurfaceErrorBoundary>
        </div>
    );
}
