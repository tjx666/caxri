import { useEffect } from 'react';

import type { SettingsTarget } from '@caxri/protocol';
import { assertNever } from '@caxri/protocol';

import { runCommand } from './commands/execute';
import { useCommandShortcuts } from './commands/use-command-shortcuts';
import { TooltipProvider } from './components/ui/tooltip';
import { AgentActionsDialog } from './features/agent-actions/agent-actions-dialog';
import { subscribeAgentChatPatches } from './features/agent-chat/agent-chat-client';
import { AgentChatWaitingPopup } from './features/agent-chat/waiting/agent-chat-waiting-popup';
import { CommanderHandoverDialog } from './features/agent-commander/commander-handover-dialog';
import { AgentMessageApprovalDialog } from './features/agent-inbox/agent-message-approval-dialog';
import { subscribeHeldMessageQueue } from './features/agent-inbox/agent-message-approval-store';
import { BugReportDialog } from './features/bug-report/bug-report-dialog';
import { ConfirmationDialog } from './features/confirmations/confirmation-dialog';
import { openFileForSession } from './features/editor/document-commands';
import { subscribeEditorBackups } from './features/editor/editor-backups';
import { scheduleCodeEditorPreload } from './features/editor/editor-loader';
import { useExternalDocumentSync } from './features/editor/external-sync';
import { subscribeUnsavedEditorRequests } from './features/editor/unsaved-editor-commands';
import { KeyboardShortcutsDialog } from './features/keyboard-shortcuts/keyboard-shortcuts-dialog';
import { CommandPalette } from './features/palette/command-palette';
import { PathBrowserDialog } from './features/path-browser/path-browser-dialog';
import { PerformanceOverlay } from './features/performance-monitor/performance-overlay';
import { useDeliveryFocusRefresh } from './features/primary-sidebar/hooks/use-delivery-focus-refresh';
import { useTranslucentSidebar } from './features/primary-sidebar/hooks/use-translucent-sidebar';
import { PrimarySidebar } from './features/primary-sidebar/primary-sidebar';
import { ProjectIconDialog } from './features/primary-sidebar/project-icon-dialog';
import { ProjectSearchDialog } from './features/project-search/project-search-dialog';
import { RendererPerformanceProfiler } from './features/renderer-performance/renderer-performance-profiler';
import { ScreencastOverlay } from './features/screencast/screencast-overlay';
import { SecondarySidebar } from './features/secondary-sidebar/secondary-sidebar';
import {
    getSecondarySidebarYieldScope,
    useIsSecondarySidebarShown,
    useSecondarySidebarYieldSync,
} from './features/secondary-sidebar/secondary-sidebar-visibility';
import { useStatusOnNewPullRequest } from './features/secondary-sidebar/status-on-new-pull-request';
import { ArchivedSessionsDialog } from './features/session/archived-sessions-dialog';
import { CreateSessionDialog } from './features/session/create-session-dialog';
import { createDesktopOpenQueue } from './features/session/desktop-open';
import { useSessionLookTracker } from './features/session/hooks/use-session-look-tracker';
import { useSessionMruSwitcherLifecycle } from './features/session/hooks/use-session-mru-switcher-lifecycle';
import { useSessionNavigationHistory } from './features/session/hooks/use-session-navigation-history';
import { useSessionAttentionAcknowledgement } from './features/session/session-attention';
import { didSelectSession } from './features/session/session-commands';
import { SessionMruSwitcher } from './features/session/session-mru-switcher';
import { SessionSearchDialog } from './features/session/session-search/session-search-dialog';
import { useSettingsTabOpener } from './features/settings/settings-tab-opener';
import { ConnectSshHostDialog } from './features/ssh-host/connect-ssh-host-dialog';
import { isConnectionOverlayVisible } from './features/ssh-host/connection-status';
import { subscribeFileWatchLimitAlerts } from './features/ssh-host/file-watch-limit-alert';
import { SshHostFolderPickerDialog } from './features/ssh-host/ssh-host-folder-picker-dialog';
import { SshHostLayer } from './features/ssh-host/ssh-host-layer';
import { StatusBar } from './features/status-bar/status-bar';
import { ToastOutlet } from './features/toasts/toast-outlet';
import { UpdateDialog } from './features/updates/update-dialog';
import { useFileMutationReconciliation } from './features/view-containers/resource-explorer/file-operation-reconciliation';
import { revealDirectoryInFiles } from './features/view-containers/resource-explorer/reveal-in-files';
import { startViewEventBridge } from './features/view-containers/view-event-bridge';
import { useWindowZoomFactor } from './features/window-zoom/use-window-zoom-factor';
import { WindowZoomHud } from './features/window-zoom/window-zoom-hud';
import { LoadingScreen } from './features/workbench/loading-screen';
import { PanelDivider } from './features/workbench/panel-divider';
import { WorkbenchColumn } from './features/workbench/workbench-column';
import { activeWorkbenchFocusElement } from './features/workbench/workbench-focus';
import { WorkbenchRootPrompt } from './features/workbench/workbench-root-prompt';
import { useStartupLoaderRemoval } from './hooks/use-startup-loader-removal';
import { useWorkbenchAppearance } from './hooks/use-workbench-appearance';
import { useTranslation } from './i18n';
import { registerPickerFallbackFocus } from './lib/picker-final-focus';
import { cn } from './lib/utilities';
import { queryClient } from './queries/client';
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
import { useDialogStore } from './stores/dialogs';
import { subscribeEnvironment, useSshEnvironment } from './stores/environment';
import { useIsFullScreen } from './stores/selectors';
import { syncWindowFullScreen } from './stores/window-full-screen';
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
            revealDirectory: revealDirectoryInFiles,
            selectSession: didSelectSession,
        });
        // Fire-and-forget: initializeWorkbench() catches its own Server request failures.
        void initializeWorkbench();
        const unsubscribe = subscribeWorkbenchEvents({
            onCommand: (command, wasViaAccelerator) =>
                runCommand(command, undefined, { viaAccelerator: wasViaAccelerator }),
            onSettingsTarget: (target: SettingsTarget) => {
                // `SettingsTarget` has only one `kind` today, so this switch is trivially exhaustive; it stays a switch
                // (with the `assertNever(target.kind, ...)` default below) so adding a second `kind` later gets a real
                // compiler error instead of silent fallthrough.
                /* oxlint-disable typescript/no-unnecessary-condition -- see comment above */
                switch (target.kind) {
                    case 'agentExecutable':
                        useDialogStore.getState().openSettings('agent-executable', target.provider);
                        return;
                    default:
                        // `assertNever(target.kind, ...)`, not `assertNever(target, ...)`: with only one member today,
                        // `SettingsTarget` is a plain object type rather than a real union, so TypeScript cannot narrow
                        // the whole value to `never` here; only its literal `kind` property does. Once a second
                        // `kind` is added this still catches an unhandled case, because `target.kind` then narrows to
                        // that member's literal instead of `never`.
                        assertNever(target.kind, 'Unhandled Settings deep-link target');
                }
                /* oxlint-enable typescript/no-unnecessary-condition */
            },
            onDesktopOpen: ({ focusEditor, kind, location, path, sessionId }) => {
                // Fire-and-forget: a rejection here surfaces through the global
                // `unhandledrejection` reporter (see renderer-error-reporter.ts), which is the
                // established pattern for one-shot Server-triggered opens.
                void desktopOpenQueue.enqueue({
                    sessionId,
                    ...(path && { path }),
                    ...(kind === 'directory' && { kind }),
                    ...(location && { location }),
                    ...(focusEditor && { focusEditor: true }),
                });
            },
        });
        // Fire-and-forget: syncWindowFullScreen() swallows its own request failure.
        void syncWindowFullScreen();
        return unsubscribe;
    }, []);
}

/**
 * Mounts the hooks that follow the selected Session without rendering anything. They live in this leaf instead of `App`
 * so a Session switch or an activity update on the selected record re-renders this null component rather than the whole
 * shell and every child below it.
 */
function SessionEffects({ isAttached }: { isAttached: boolean }) {
    useFileMutationReconciliation(isAttached);
    useSessionNavigationHistory();
    useSessionAttentionAcknowledgement();
    useSessionLookTracker();
    useDeliveryFocusRefresh();
    useGitDecorationSync();
    return null;
}

export function App() {
    const { t } = useTranslation();
    const isAttached = useWorkbenchStore((state) => state.bootstrap !== undefined);
    const primarySidebarWidth = useChromeLayoutStore((state) => state.primarySidebarWidth);
    const secondarySidebarWidth = useChromeLayoutStore((state) => state.secondarySidebarWidth);
    const isPrimarySidebarVisible = useChromeLayoutStore((state) => state.primarySidebarVisible);
    const isFullScreen = useIsFullScreen();
    const isSecondarySidebarVisible = useIsSecondarySidebarShown();
    const isWorkbenchPaused = isConnectionOverlayVisible(useSshEnvironment());

    useEffect(() => subscribeEnvironment(), []);
    useEffect(() => subscribeFileWatchLimitAlerts(), []);
    useRuntimeAttachment();
    useStartupLoaderRemoval(isAttached);
    useSettingsTabOpener();
    useRuntimeQueryInvalidation();
    useEffect(() => subscribeAgentChatPatches(queryClient), []);
    useEffect(() => startViewEventBridge(), []);
    useEffect(() => subscribeHeldMessageQueue(), []);
    useEffect(() => subscribeUnsavedEditorRequests(), []);
    useEffect(() => subscribeEditorBackups(), []);
    useEffect(() => registerPickerFallbackFocus(activeWorkbenchFocusElement), []);
    useSessionMruSwitcherLifecycle();
    useCommandShortcuts();
    useExternalDocumentSync();
    useChromeViewportClamp(getSecondarySidebarYieldScope);
    useSecondarySidebarYieldSync();
    useStatusOnNewPullRequest();
    useWorkbenchAppearance();
    useTranslucentSidebar();
    useWindowZoomFactor();
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

    /**
     * Rendered at the same position in both branches so an OpenSSH prompt being answered keeps its state when the
     * Server attaches underneath it; see `SshHostLayer`.
     */
    const sshHostLayer = <SshHostLayer />;
    const sessionEffects = <SessionEffects isAttached={isAttached} />;
    if (!isAttached)
        return (
            <>
                <LoadingScreen />
                {sshHostLayer}
                {sessionEffects}
            </>
        );

    return (
        <>
            <TooltipProvider>
                <main
                    // Readable but not operable while an SSH Host reconnects; see `SshHostConnectionOverlay`.
                    inert={isWorkbenchPaused}
                    className={cn(
                        /*
                         * PrimarySidebar/SecondarySidebar widths are device-local UI state (`stores/chrome-layout.ts`), not part
                         * of the Server-synced Session; each panel writes its own custom property directly on
                         * drag and through React on commit/reset. The 6px tracks are the divider hit areas; see
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
                            className="collapsed-primary-sidebar-titlebar fixed top-0 left-0 z-20 h-9 w-(--traffic-light-clearance) [-webkit-app-region:drag]"
                        />
                    )}
                    {isPrimarySidebarVisible && (
                        <RendererPerformanceProfiler surface="primary-sidebar">
                            <PrimarySidebar />
                        </RendererPerformanceProfiler>
                    )}
                    {isPrimarySidebarVisible && (
                        <PanelDivider
                            ariaLabel={t('workbench.resizePrimarySidebar')}
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
                            ariaLabel={t('workbench.resizeSecondarySidebar')}
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
                    <CommanderHandoverDialog isFromWorkbench />
                    <SessionSearchDialog />
                    <KeyboardShortcutsDialog />
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
                    <ConnectSshHostDialog />
                    <SshHostFolderPickerDialog />
                    <ConfirmationDialog />
                    <AgentChatWaitingPopup />
                    <ToastOutlet />
                    <WindowZoomHud />
                    <ScreencastOverlay />
                    <PerformanceOverlay />
                </main>
            </TooltipProvider>
            {sshHostLayer}
            {sessionEffects}
        </>
    );
}
