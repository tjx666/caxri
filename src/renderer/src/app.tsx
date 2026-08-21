import { useEffect } from 'react';

import { cssFontFamilyEntry } from '@caxri/utils';

import { runCommand } from './commands/execute';
import { useCommandShortcuts } from './commands/use-command-shortcuts';
import { TooltipProvider } from './components/ui/tooltip';
import { AgentActionsDialog } from './features/agent-actions/agent-actions-dialog';
import { AgentMessageApprovalDialog } from './features/agent-inbox/agent-message-approval-dialog';
import { BugReportDialog } from './features/bug-report/bug-report-dialog';
import { openFileForSession } from './features/editor/document-actions';
import { scheduleCodeEditorPreload } from './features/editor/editor-loader';
import { useExternalDocumentSync } from './features/editor/external-sync';
import { Inspector } from './features/inspector/inspector';
import { useFileMutationReconciliation } from './features/inspector/panels/files/file-operation-reconciliation';
import { useFileTreeQueryInvalidation } from './features/inspector/panels/files/file-tree-refresh';
import { CommandPalette } from './features/palette/command-palette';
import { PathBrowserDialog } from './features/path-browser/path-browser-dialog';
import { ScreencastOverlay } from './features/screencast/screencast-overlay';
import { ArchivedSessionsDialog } from './features/session/archived-sessions-dialog';
import { CreateSessionDialog } from './features/session/create-session-dialog';
import { createDesktopOpenQueue } from './features/session/desktop-open';
import { didSelectSession } from './features/session/session-actions';
import { useSessionAttentionAcknowledgement } from './features/session/session-attention';
import { SessionMruSwitcher } from './features/session/session-mru-switcher';
import { useSessionMruSwitcherLifecycle } from './features/session/use-session-mru-switcher-lifecycle';
import { useSessionNavigationHistory } from './features/session/use-session-navigation-history';
import { SettingsDialog } from './features/settings/settings-dialog';
import { ProjectIconDialog } from './features/sidebar/project-icon-dialog';
import { ProjectSidebar } from './features/sidebar/project-sidebar';
import { StatusBar } from './features/status-bar/status-bar';
import { ToastOutlet } from './features/toasts/toast-outlet';
import { UpdateDialog } from './features/updates/update-dialog';
import { LoadingScreen } from './features/workbench/loading-screen';
import { PanelDivider } from './features/workbench/panel-divider';
import { WorkbenchColumn } from './features/workbench/workbench-column';
import { WorkbenchRootPrompt } from './features/workbench/workbench-root-prompt';
import { applyCssTheme } from './lib/theme-css';
import { cn } from './lib/utilities';
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
import { useSettings, useTheme } from './stores/selectors';
import {
    initializeWorkbench,
    subscribeWorkbenchEvents,
    useWorkbenchStore,
} from './stores/workbench';

/**
 * Attaches to the Runtime and keeps the snapshot current. `initialize` is single-flight, so React StrictMode's double
 * mount issues one `app.bootstrap` request rather than two.
 */
function useRuntimeAttachment(): void {
    useEffect(() => {
        const desktopOpenQueue = createDesktopOpenQueue({
            openFile: openFileForSession,
            selectSession: didSelectSession,
        });
        // Fire-and-forget: initializeWorkbench() catches its own Runtime request failures.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void initializeWorkbench();
        return subscribeWorkbenchEvents({
            onCommand: (command, wasViaAccelerator) =>
                runCommand(command, undefined, { viaAccelerator: wasViaAccelerator }),
            onDesktopOpen: (sessionId, path) => {
                // Fire-and-forget: a rejection here surfaces through the global
                // `unhandledrejection` reporter (see renderer-error-reporter.ts), which is the
                // established pattern for one-shot Host-triggered opens.
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                void desktopOpenQueue.enqueue({ sessionId, ...(path && { path }) });
            },
        });
    }, []);
}

export function App() {
    const isAttached = useWorkbenchStore((state) => state.bootstrap !== undefined);
    const theme = useTheme();
    const workbenchFontFamily = useSettings()?.['workbench.fontFamily'];
    const sidebarWidth = usePanelLayoutStore((state) => state.sidebarWidth);
    const inspectorWidth = usePanelLayoutStore((state) => state.inspectorWidth);
    const isSidebarVisible = usePanelLayoutStore((state) => state.sidebarVisible);
    const isInspectorVisible = usePanelLayoutStore((state) => state.inspectorVisible);

    useRuntimeAttachment();
    useFileMutationReconciliation(isAttached);
    useRuntimeQueryInvalidation();
    useFileTreeQueryInvalidation();
    useSessionMruSwitcherLifecycle();
    useSessionNavigationHistory();
    useCommandShortcuts();
    useSessionAttentionAcknowledgement();
    useExternalDocumentSync();
    usePanelViewportClamp();
    useEffect(() => {
        if (theme) applyCssTheme(theme);
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
    useEffect(() => {
        if (!isAttached) return;
        return scheduleCodeEditorPreload();
    }, [isAttached]);
    /**
     * Only the committed width reaches the DOM through React; a drag in progress writes the same custom property
     * directly (see `PanelDivider`), so this effect never fires mid-gesture.
     */
    useEffect(() => {
        document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
    }, [sidebarWidth]);
    useEffect(() => {
        document.documentElement.style.setProperty('--inspector-width', `${inspectorWidth}px`);
    }, [inspectorWidth]);

    if (!isAttached) return <LoadingScreen />;

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
                    'app-shell grid h-screen w-screen grid-rows-[minmax(0,1fr)_24px] bg-background',
                    isSidebarVisible && isInspectorVisible
                        ? 'grid-cols-[var(--sidebar-width,230px)_6px_minmax(320px,1fr)_6px_var(--inspector-width,310px)]'
                        : isSidebarVisible
                          ? 'inspector-collapsed grid-cols-[var(--sidebar-width,230px)_6px_minmax(320px,1fr)]'
                          : isInspectorVisible
                            ? 'sidebar-collapsed grid-cols-[minmax(320px,1fr)_6px_var(--inspector-width,310px)]'
                            : 'sidebar-collapsed inspector-collapsed grid-cols-[minmax(320px,1fr)]',
                )}
            >
                {!isSidebarVisible && (
                    <div
                        aria-hidden="true"
                        className="collapsed-sidebar-titlebar fixed top-0 left-0 z-20 h-11 w-[78px] [-webkit-app-region:drag]"
                    />
                )}
                {isSidebarVisible && <ProjectSidebar />}
                {isSidebarVisible && (
                    <PanelDivider
                        ariaLabel="Resize Sidebar"
                        size={sidebarWidth}
                        min={SIDEBAR_MIN_WIDTH}
                        max={SIDEBAR_MAX_WIDTH}
                        defaultSize={SIDEBAR_DEFAULT_WIDTH}
                        cssVariable="--sidebar-width"
                        growDirection={1}
                        orientation="vertical"
                        onCommit={(width) => usePanelLayoutStore.getState().setSidebarWidth(width)}
                    />
                )}
                <WorkbenchColumn />
                {isInspectorVisible && (
                    <PanelDivider
                        ariaLabel="Resize Inspector"
                        size={inspectorWidth}
                        min={INSPECTOR_MIN_WIDTH}
                        max={INSPECTOR_MAX_WIDTH}
                        defaultSize={INSPECTOR_DEFAULT_WIDTH}
                        cssVariable="--inspector-width"
                        growDirection={-1}
                        orientation="vertical"
                        onCommit={(width) =>
                            usePanelLayoutStore.getState().setInspectorWidth(width)
                        }
                    />
                )}
                {isInspectorVisible && <Inspector />}
                <StatusBar />
                <CreateSessionDialog />
                <ArchivedSessionsDialog />
                <SettingsDialog />
                <UpdateDialog />
                <CommandPalette />
                <AgentActionsDialog />
                <PathBrowserDialog />
                <BugReportDialog />
                <ProjectIconDialog />
                <AgentMessageApprovalDialog />
                <SessionMruSwitcher />
                <WorkbenchRootPrompt />
                <ToastOutlet />
                <ScreencastOverlay />
            </main>
        </TooltipProvider>
    );
}
