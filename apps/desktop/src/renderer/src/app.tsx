import { useEffect } from 'react';

import { runCommand } from './commands/execute';
import { useCommandShortcuts } from './commands/use-command-shortcuts';
import { TooltipProvider } from './components/ui/tooltip';
import { AgentActionsDialog } from './features/agent-actions/agent-actions-dialog';
import { AgentMessageApprovalDialog } from './features/agent-inbox/agent-message-approval-dialog';
import { BugReportDialog } from './features/bug-report/bug-report-dialog';
import { ConfirmationDialog } from './features/confirmations/confirmation-dialog';
import { openFileForSession } from './features/editor/document-commands';
import { scheduleCodeEditorPreload } from './features/editor/editor-loader';
import { useExternalDocumentSync } from './features/editor/external-sync';
import { CommandPalette } from './features/palette/command-palette';
import { PathBrowserDialog } from './features/path-browser/path-browser-dialog';
import { useDeliveryFocusRefresh } from './features/primary-sidebar/hooks/use-delivery-focus-refresh';
import { PrimarySidebar } from './features/primary-sidebar/primary-sidebar';
import { ProjectIconDialog } from './features/primary-sidebar/project-icon-dialog';
import { ProjectSearchDialog } from './features/project-search/project-search-dialog';
import { RendererPerformanceProfiler } from './features/renderer-performance/renderer-performance-profiler';
import { ScreencastOverlay } from './features/screencast/screencast-overlay';
import { SecondarySidebar } from './features/secondary-sidebar/secondary-sidebar';
import { ArchivedSessionsDialog } from './features/session/archived-sessions-dialog';
import { ContentSearchDialog } from './features/session/content-search/content-search-dialog';
import { CreateSessionDialog } from './features/session/create-session-dialog';
import { createDesktopOpenQueue } from './features/session/desktop-open';
import { useSessionAttentionAcknowledgement } from './features/session/session-attention';
import { didSelectSession } from './features/session/session-commands';
import { SessionMruSwitcher } from './features/session/session-mru-switcher';
import { useSessionMruSwitcherLifecycle } from './features/session/use-session-mru-switcher-lifecycle';
import { useSessionNavigationHistory } from './features/session/use-session-navigation-history';
import { useSettingsTabOpener } from './features/settings/settings-tab-opener';
import { StatusBar } from './features/status-bar/status-bar';
import { ToastOutlet } from './features/toasts/toast-outlet';
import { UpdateDialog } from './features/updates/update-dialog';
import { useFileMutationReconciliation } from './features/view-containers/resource-explorer/file-operation-reconciliation';
import { startViewEventBridge } from './features/view-containers/view-event-bridge';
import { LoadingScreen } from './features/workbench/loading-screen';
import { PanelDivider } from './features/workbench/panel-divider';
import { WorkbenchColumn } from './features/workbench/workbench-column';
import { activeWorkbenchFocusElement } from './features/workbench/workbench-focus';
import { WorkbenchRootPrompt } from './features/workbench/workbench-root-prompt';
import { useStartupLoaderRemoval } from './hooks/use-startup-loader-removal';
import { useWorkbenchAppearance } from './hooks/use-workbench-appearance';
import { registerPickerFallbackFocus } from './lib/picker-final-focus';
import { cn } from './lib/utilities';
import { useGitDecorationSync } from './queries/git-decoration-sync';
import { useRuntimeQueryInvalidation } from './queries/invalidation';
import {
    PRIMARY_SIDEBAR_DEFAULT_WIDTH,
    PRIMARY_SIDEBAR_MAX_WIDTH,
    PRIMARY_SIDEBAR_MIN_WIDTH,
    SECONDARY_SIDEBAR_DEFAULT_WIDTH,
    SECONDARY_SIDEBAR_MAX_WIDTH,
    SECONDARY_SIDEBAR_MIN_WIDTH,
    useChromeLayoutStore,
    useChromeViewportClamp,
} from './stores/chrome-layout';
import { useIsFullScreen, useSettings } from './stores/selectors';
import {
    initializeWorkbench,
    subscribeWorkbenchEvents,
    useWorkbenchStore,
} from './stores/workbench';

/**
 * Attaches to the Server and keeps the snapshot current. `initialize` is single-flight, so React StrictMode's double
 * mount issues one `app.bootstrap` request rather than two.
 */
function useRuntimeAttachment(): void {
    useEffect(() => {
        const desktopOpenQueue = createDesktopOpenQueue({
            openFile: async (sessionId, path, options) => {
                return openFileForSession(sessionId, path, {
                    ...(options?.location && { location: options.location }),
                    ...(options?.focusEditor && { focus: true }),
                });
            },
            selectSession: didSelectSession,
        });
        // Fire-and-forget: initializeWorkbench() catches its own Server request failures.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void initializeWorkbench();
        return subscribeWorkbenchEvents({
            onCommand: (command, wasViaAccelerator) =>
                runCommand(command, undefined, { viaAccelerator: wasViaAccelerator }),
            onDesktopOpen: (sessionId, path, options) => {
                // Fire-and-forget: a rejection here surfaces through the global
                // `unhandledrejection` reporter (see renderer-error-reporter.ts), which is the
                // established pattern for one-shot Server-triggered opens.
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                void desktopOpenQueue.enqueue({
                    sessionId,
                    ...(path && { path }),
                    ...(options?.location && { location: options.location }),
                    ...(options?.focusEditor && { focusEditor: true }),
                });
            },
        });
    }, []);
}

export function App() {
    const isAttached = useWorkbenchStore((state) => state.bootstrap !== undefined);
    const zoomLevel = useSettings()?.['window.zoomLevel'] ?? 0;
    const primarySidebarWidth = useChromeLayoutStore((state) => state.primarySidebarWidth);
    const secondarySidebarWidth = useChromeLayoutStore((state) => state.secondarySidebarWidth);
    const isPrimarySidebarVisible = useChromeLayoutStore((state) => state.primarySidebarVisible);
    const isFullScreen = useIsFullScreen();
    const isSecondarySidebarVisible = useChromeLayoutStore(
        (state) => state.secondarySidebarVisible,
    );

    useRuntimeAttachment();
    useStartupLoaderRemoval(isAttached);
    useSettingsTabOpener();
    useFileMutationReconciliation(isAttached);
    useRuntimeQueryInvalidation();
    useEffect(() => startViewEventBridge(), []);
    useEffect(() => registerPickerFallbackFocus(activeWorkbenchFocusElement), []);
    useSessionMruSwitcherLifecycle();
    useSessionNavigationHistory();
    useCommandShortcuts();
    useSessionAttentionAcknowledgement();
    useDeliveryFocusRefresh();
    useExternalDocumentSync();
    useGitDecorationSync();
    useChromeViewportClamp();
    useWorkbenchAppearance();
    /**
     * Page zoom scales every CSS pixel but not the native traffic lights, so the header clearances reserved for them
     * divide by this factor to stay the lights' physical width. Main applies the zoom itself; this mirrors the same
     * setting with the same 20%-per-step formula (`zoomFactorForLevel` in `main/window-chrome.ts`).
     */
    useEffect(() => {
        document.documentElement.style.setProperty(
            '--window-zoom-factor',
            String(1.2 ** zoomLevel),
        );
    }, [zoomLevel]);
    useEffect(() => {
        if (!isAttached) return;
        return scheduleCodeEditorPreload();
    }, [isAttached]);
    /**
     * Only the committed width reaches the DOM through React; a drag in progress writes the same custom property
     * directly (see `PanelDivider`), so this effect never fires mid-gesture.
     */
    useEffect(() => {
        document.documentElement.style.setProperty(
            '--primary-sidebar-width',
            `${primarySidebarWidth}px`,
        );
    }, [primarySidebarWidth]);
    useEffect(() => {
        document.documentElement.style.setProperty(
            '--secondary-sidebar-width',
            `${secondarySidebarWidth}px`,
        );
    }, [secondarySidebarWidth]);

    if (!isAttached) return <LoadingScreen />;

    return (
        <TooltipProvider>
            <main
                className={cn(
                    /*
                     * PrimarySidebar/SecondarySidebar widths are device-local UI state (`stores/chrome-layout.ts`), not part
                     * of the Server-synced Session; each panel writes its own custom property directly on
                     * drag and through React on commit/reset. The 6px tracks are the divider hit areas — see
                     * `PanelDivider`. `minmax(320px, 1fr)` reserves the main pane so a resize never overlaps it.
                     */
                    'app-shell grid h-screen w-screen grid-rows-[minmax(0,1fr)_24px] bg-background',
                    isPrimarySidebarVisible && isSecondarySidebarVisible
                        ? 'grid-cols-[var(--primary-sidebar-width,230px)_6px_minmax(320px,1fr)_6px_var(--secondary-sidebar-width,310px)]'
                        : isPrimarySidebarVisible
                          ? 'secondary-sidebar-collapsed grid-cols-[var(--primary-sidebar-width,230px)_6px_minmax(320px,1fr)]'
                          : isSecondarySidebarVisible
                            ? 'primary-sidebar-collapsed grid-cols-[minmax(320px,1fr)_6px_var(--secondary-sidebar-width,310px)]'
                            : 'primary-sidebar-collapsed secondary-sidebar-collapsed grid-cols-[minmax(320px,1fr)]',
                )}
            >
                {!isPrimarySidebarVisible && !isFullScreen && (
                    <div
                        aria-hidden="true"
                        className="collapsed-primary-sidebar-titlebar fixed top-0 left-0 z-20 h-11 w-(--traffic-light-clearance) [-webkit-app-region:drag]"
                    />
                )}
                {isPrimarySidebarVisible && (
                    <RendererPerformanceProfiler surface="primary-sidebar">
                        <PrimarySidebar />
                    </RendererPerformanceProfiler>
                )}
                {isPrimarySidebarVisible && (
                    <PanelDivider
                        ariaLabel="Resize Primary Side Bar"
                        size={primarySidebarWidth}
                        min={PRIMARY_SIDEBAR_MIN_WIDTH}
                        max={PRIMARY_SIDEBAR_MAX_WIDTH}
                        defaultSize={PRIMARY_SIDEBAR_DEFAULT_WIDTH}
                        cssVariable="--primary-sidebar-width"
                        growDirection={1}
                        orientation="vertical"
                        onCommit={(width) =>
                            useChromeLayoutStore.getState().setPrimarySidebarWidth(width)
                        }
                    />
                )}
                <RendererPerformanceProfiler surface="workbench">
                    <WorkbenchColumn />
                </RendererPerformanceProfiler>
                {isSecondarySidebarVisible && (
                    <PanelDivider
                        ariaLabel="Resize Secondary Side Bar"
                        size={secondarySidebarWidth}
                        min={SECONDARY_SIDEBAR_MIN_WIDTH}
                        max={SECONDARY_SIDEBAR_MAX_WIDTH}
                        defaultSize={SECONDARY_SIDEBAR_DEFAULT_WIDTH}
                        cssVariable="--secondary-sidebar-width"
                        growDirection={-1}
                        orientation="vertical"
                        onCommit={(width) =>
                            useChromeLayoutStore.getState().setSecondarySidebarWidth(width)
                        }
                    />
                )}
                {isSecondarySidebarVisible && (
                    <RendererPerformanceProfiler surface="secondary-sidebar">
                        <SecondarySidebar />
                    </RendererPerformanceProfiler>
                )}
                <StatusBar />
                <CreateSessionDialog />
                <ArchivedSessionsDialog />
                <ContentSearchDialog />
                <UpdateDialog />
                <CommandPalette />
                <ProjectSearchDialog />
                <AgentActionsDialog />
                <PathBrowserDialog />
                <BugReportDialog />
                <ProjectIconDialog />
                <AgentMessageApprovalDialog />
                <SessionMruSwitcher />
                <WorkbenchRootPrompt />
                <ConfirmationDialog />
                <ToastOutlet />
                <ScreencastOverlay />
            </main>
        </TooltipProvider>
    );
}
