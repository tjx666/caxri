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
import { Workbench } from '../features/workbench/Workbench';
import { applyCssTheme } from '../lib/theme-css';
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

    useRuntimeAttachment();
    useCommandShortcuts();
    useExternalDocumentSync();
    useEffect(() => {
        if (theme) applyCssTheme(theme);
    }, [theme]);

    if (!attached) return <LoadingScreen />;

    return (
        <main className="app-shell">
            <ProjectSidebar />
            <Workbench />
            <Inspector />
            <StatusBar />
            <CreateSessionDialog />
            <SettingsDialog />
            <CommandPalette />
            <ToastOutlet />
        </main>
    );
}
