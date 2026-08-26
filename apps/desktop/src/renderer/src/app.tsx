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
import { CommandPalette } from './features/palette/command-palette';
import { PathBrowserDialog } from './features/path-browser/path-browser-dialog';
import { PrimarySidebar } from './features/primary-sidebar/primary-sidebar';
import { ProjectIconDialog } from './features/primary-sidebar/project-icon-dialog';
import { ScreencastOverlay } from './features/screencast/screencast-overlay';
import { SecondarySidebar } from './features/secondary-sidebar/secondary-sidebar';
import { ArchivedSessionsDialog } from './features/session/archived-sessions-dialog';
import { CreateSessionDialog } from './features/session/create-session-dialog';
import { createDesktopOpenQueue } from './features/session/desktop-open';
import { didSelectSession } from './features/session/session-actions';
import { useSessionAttentionAcknowledgement } from './features/session/session-attention';
import { SessionMruSwitcher } from './features/session/session-mru-switcher';
import { useSessionMruSwitcherLifecycle } from './features/session/use-session-mru-switcher-lifecycle';
import { useSessionNavigationHistory } from './features/session/use-session-navigation-history';
import { SettingsDialog } from './features/settings/settings-dialog';
import { StatusBar } from './features/status-bar/status-bar';
import { ToastOutlet } from './features/toasts/toast-outlet';
import { UpdateDialog } from './features/updates/update-dialog';
import { useFileMutationReconciliation } from './features/view-containers/resource-explorer/file-operation-reconciliation';
import { startViewEventBridge } from './features/view-containers/view-event-bridge';
import { LoadingScreen } from './features/workbench/loading-screen';
import { PanelDivider } from './features/workbench/panel-divider';
import { WorkbenchColumn } from './features/workbench/workbench-column';
import { WorkbenchRootPrompt } from './features/workbench/workbench-root-prompt';
import { applyCssTheme } from './lib/theme-css';
import { cn } from './lib/utilities';
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
            openFile: async (sessionId, path, location) => {
                return openFileForSession(sessionId, path, location ? { location } : {});
            },
            selectSession: didSelectSession,
        });
        // Fire-and-forget: initializeWorkbench() catches its own Runtime request failures.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void initializeWorkbench();
        return subscribeWorkbenchEvents({
            onCommand: (command, wasViaAccelerator) =>
                runCommand(command, undefined, { viaAccelerator: wasViaAccelerator }),
            onDesktopOpen: (sessionId, path, location) => {
                // Fire-and-forget: a rejection here surfaces through the global
                // `unhandledrejection` reporter (see renderer-error-reporter.ts), which is the
                // established pattern for one-shot Host-triggered opens.
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                void desktopOpenQueue.enqueue({
                    sessionId,
                    ...(path && { path }),
                    ...(location && { location }),
                });
            },
        });
    }, []);
}

export function App() {
    const isAttached = useWorkbenchStore((state) => state.bootstrap !== undefined);
    const theme = useTheme();
    const workbenchFontFamily = useSettings()?.['workbench.fontFamily'];
    const primarySidebarWidth = useChromeLayoutStore((state) => state.primarySidebarWidth);
    const secondarySidebarWidth = useChromeLayoutStore((state) => state.secondarySidebarWidth);
    const isPrimarySidebarVisible = useChromeLayoutStore((state) => state.primarySidebarVisible);
    const isSecondarySidebarVisible = useChromeLayoutStore(
        (state) => state.secondarySidebarVisible,
    );

    useRuntimeAttachment();
    useFileMutationReconciliation(isAttached);
    useRuntimeQueryInvalidation();
    useEffect(() => startViewEventBridge(), []);
    useSessionMruSwitcherLifecycle();
    useSessionNavigationHistory();
    useCommandShortcuts();
    useSessionAttentionAcknowledgement();
    useExternalDocumentSync();
    useChromeViewportClamp();
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
                     * of the Runtime-synced Session; each panel writes its own custom property directly on
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
                {!isPrimarySidebarVisible && (
                    <div
                        aria-hidden="true"
                        className="collapsed-primary-sidebar-titlebar fixed top-0 left-0 z-20 h-11 w-[78px] [-webkit-app-region:drag]"
                    />
                )}
                {isPrimarySidebarVisible && <PrimarySidebar />}
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
                <WorkbenchColumn />
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
                {isSecondarySidebarVisible && <SecondarySidebar />}
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
