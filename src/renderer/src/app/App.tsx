import { useEffect } from 'react';

import { runCommand } from '../commands/execute';
import { useCommandShortcuts } from '../commands/useCommandShortcuts';
import { useExternalDocumentSync } from '../features/editor/external-sync';
import { Inspector } from '../features/inspector/Inspector';
import { CommandPalette } from '../features/palette/CommandPalette';
import { CreateSessionDialog } from '../features/session/CreateSessionDialog';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { ProjectSidebar } from '../features/sidebar/ProjectSidebar';
import { StatusBar } from '../features/status/StatusBar';
import { ToastOutlet } from '../features/toasts/ToastOutlet';
import { LoadingScreen } from '../features/workbench/LoadingScreen';
import { PanelDivider } from '../features/workbench/PanelDivider';
import { Workbench } from '../features/workbench/Workbench';
import { applyCssTheme } from '../lib/theme-css';
import {
    INSPECTOR_DEFAULT_WIDTH,
    INSPECTOR_MAX_WIDTH,
    INSPECTOR_MIN_WIDTH,
    SIDEBAR_DEFAULT_WIDTH,
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_MIN_WIDTH,
    usePanelLayoutStore,
    usePanelViewportClamp,
} from '../state/panel-layout';
import { useRuntimeQueryInvalidation } from '../state/queries';
import { useTheme } from '../state/selectors';
import {
    initializeWorkbench,
    subscribeWorkbenchEvents,
    useWorkbenchStore,
} from '../state/workbench';

/**
 * Attaches to the Runtime and keeps the snapshot current. `initialize` is single-flight, so React
 * StrictMode's double mount issues one `app.bootstrap` request rather than two.
 */
function useRuntimeAttachment(): void {
    useEffect(() => {
        void initializeWorkbench();
        return subscribeWorkbenchEvents({ onCommand: runCommand });
    }, []);
}

export default function App() {
    const attached = useWorkbenchStore((state) => state.bootstrap !== undefined);
    const theme = useTheme();
    const sidebarWidth = usePanelLayoutStore((state) => state.sidebarWidth);
    const inspectorWidth = usePanelLayoutStore((state) => state.inspectorWidth);
    const inspectorVisible = usePanelLayoutStore((state) => state.inspectorVisible);

    useRuntimeAttachment();
    useRuntimeQueryInvalidation();
    useCommandShortcuts();
    useExternalDocumentSync();
    usePanelViewportClamp();
    useEffect(() => {
        if (theme) applyCssTheme(theme);
    }, [theme]);
    /**
     * Only the committed width reaches the DOM through React; a drag in progress writes the same
     * custom property directly (see `PanelDivider`), so this effect never fires mid-gesture.
     */
    useEffect(() => {
        document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
    }, [sidebarWidth]);
    useEffect(() => {
        document.documentElement.style.setProperty('--inspector-width', `${inspectorWidth}px`);
    }, [inspectorWidth]);

    if (!attached) return <LoadingScreen />;

    return (
        <main className={inspectorVisible ? 'app-shell' : 'app-shell inspector-collapsed'}>
            <ProjectSidebar />
            <PanelDivider
                ariaLabel="Resize Sidebar"
                width={sidebarWidth}
                min={SIDEBAR_MIN_WIDTH}
                max={SIDEBAR_MAX_WIDTH}
                defaultWidth={SIDEBAR_DEFAULT_WIDTH}
                cssVariable="--sidebar-width"
                growDirection={1}
                onCommit={(width) => usePanelLayoutStore.getState().setSidebarWidth(width)}
            />
            <Workbench />
            {inspectorVisible && (
                <PanelDivider
                    ariaLabel="Resize Inspector"
                    width={inspectorWidth}
                    min={INSPECTOR_MIN_WIDTH}
                    max={INSPECTOR_MAX_WIDTH}
                    defaultWidth={INSPECTOR_DEFAULT_WIDTH}
                    cssVariable="--inspector-width"
                    growDirection={-1}
                    onCommit={(width) => usePanelLayoutStore.getState().setInspectorWidth(width)}
                />
            )}
            {inspectorVisible && <Inspector />}
            <StatusBar />
            <CreateSessionDialog />
            <SettingsDialog />
            <CommandPalette />
            <ToastOutlet />
        </main>
    );
}
