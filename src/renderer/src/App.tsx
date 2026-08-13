import { useEffect } from 'react';

import { runCommand } from './commands/execute';
import { useCommandShortcuts } from './commands/useCommandShortcuts';
import { BugReportDialog } from './features/bug-report/BugReportDialog';
import { AgentMessageApprovalDialog } from './features/agent-inbox/AgentMessageApprovalDialog';
import { useExternalDocumentSync } from './features/editor/external-sync';
import { openFile } from './features/editor/document-actions';
import { scheduleCodeEditorPreload } from './features/editor/editor-loader';
import { Inspector } from './features/inspector/Inspector';
import { useFileMutationReconciliation } from './features/inspector/panels/files/file-operation-reconciliation';
import { CommandPalette } from './features/palette/CommandPalette';
import { PathBrowserDialog } from './features/path-browser/PathBrowserDialog';
import { ScreencastOverlay } from './features/screencast/ScreencastOverlay';
import { CreateSessionDialog } from './features/session/CreateSessionDialog';
import { ArchivedSessionsDialog } from './features/session/ArchivedSessionsDialog';
import { useSessionAttentionAcknowledgement } from './features/session/session-attention';
import { selectSession } from './features/session/session-actions';
import { SettingsDialog } from './features/settings/SettingsDialog';
import { ProjectSidebar } from './features/sidebar/ProjectSidebar';
import { StatusBar } from './features/status-bar/StatusBar';
import { ToastOutlet } from './features/toasts/ToastOutlet';
import { UpdateDialog } from './features/updates/UpdateDialog';
import { LoadingScreen } from './features/workbench/LoadingScreen';
import { PanelDivider } from './features/workbench/PanelDivider';
import { Workbench } from './features/workbench/Workbench';
import { TooltipProvider } from './components/ui/tooltip';
import { applyCssTheme } from './lib/theme-css';
import { cn } from './lib/utils';
import { useRuntimeQueryInvalidation } from './queries/invalidation';
import {
    INSPECTOR_DEFAULT_WIDTH,
    INSPECTOR_MAX_WIDTH,
    INSPECTOR_MIN_WIDTH,
    SIDEBAR_DEFAULT_WIDTH,
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_MIN_WIDTH,
    usePanelLayoutStore,
    usePanelViewportClamp,
} from './stores/panel-layout';
import { useTheme } from './stores/selectors';
import {
    initializeWorkbench,
    subscribeWorkbenchEvents,
    useWorkbenchStore,
} from './stores/workbench';

/**
 * Attaches to the Runtime and keeps the snapshot current. `initialize` is single-flight, so React
 * StrictMode's double mount issues one `app.bootstrap` request rather than two.
 */
function useRuntimeAttachment(): void {
    useEffect(() => {
        void initializeWorkbench();
        return subscribeWorkbenchEvents({
            onCommand: (command, viaAccelerator) =>
                runCommand(command, undefined, { viaAccelerator }),
            onDesktopOpen: (sessionId, path) => {
                void (async () => {
                    await selectSession(sessionId);
                    if (path) await openFile(path);
                })();
            },
        });
    }, []);
}

export function App() {
    const attached = useWorkbenchStore((state) => state.bootstrap !== undefined);
    const theme = useTheme();
    const sidebarWidth = usePanelLayoutStore((state) => state.sidebarWidth);
    const inspectorWidth = usePanelLayoutStore((state) => state.inspectorWidth);
    const sidebarVisible = usePanelLayoutStore((state) => state.sidebarVisible);
    const inspectorVisible = usePanelLayoutStore((state) => state.inspectorVisible);

    useRuntimeAttachment();
    useFileMutationReconciliation(attached);
    useRuntimeQueryInvalidation();
    useCommandShortcuts();
    useSessionAttentionAcknowledgement();
    useExternalDocumentSync();
    usePanelViewportClamp();
    useEffect(() => {
        if (theme) applyCssTheme(theme);
    }, [theme]);
    useEffect(() => {
        if (!attached) return;
        return scheduleCodeEditorPreload();
    }, [attached]);
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
        <TooltipProvider>
            <main
                className={cn(
                    /*
                     * Sidebar/Inspector widths are device-local UI state (`stores/panel-layout.ts`), not part
                     * of the Runtime-synced Session; each panel writes its own custom property directly on
                     * drag and through React on commit/reset. The 6px tracks are the divider hit areas — see
                     * `PanelDivider`. `minmax(320px, 1fr)` reserves the main pane so a resize never overlaps it.
                     */
                    'app-shell grid w-screen h-screen bg-background grid-rows-[minmax(0,1fr)_24px]',
                    sidebarVisible && inspectorVisible
                        ? 'grid-cols-[var(--sidebar-width,230px)_6px_minmax(320px,1fr)_6px_var(--inspector-width,310px)]'
                        : sidebarVisible
                          ? 'inspector-collapsed grid-cols-[var(--sidebar-width,230px)_6px_minmax(320px,1fr)]'
                          : inspectorVisible
                            ? 'sidebar-collapsed grid-cols-[minmax(320px,1fr)_6px_var(--inspector-width,310px)]'
                            : 'sidebar-collapsed inspector-collapsed grid-cols-[minmax(320px,1fr)]',
                )}
            >
                {!sidebarVisible && (
                    <div
                        aria-hidden="true"
                        className="collapsed-sidebar-titlebar fixed top-0 left-0 z-20 h-11 w-[78px] [-webkit-app-region:drag]"
                    />
                )}
                {sidebarVisible && <ProjectSidebar />}
                {sidebarVisible && (
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
                )}
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
                        onCommit={(width) =>
                            usePanelLayoutStore.getState().setInspectorWidth(width)
                        }
                    />
                )}
                {inspectorVisible && <Inspector />}
                <StatusBar />
                <CreateSessionDialog />
                <ArchivedSessionsDialog />
                <SettingsDialog />
                <UpdateDialog />
                <CommandPalette />
                <PathBrowserDialog />
                <BugReportDialog />
                <AgentMessageApprovalDialog />
                <ToastOutlet />
                <ScreencastOverlay />
            </main>
        </TooltipProvider>
    );
}
