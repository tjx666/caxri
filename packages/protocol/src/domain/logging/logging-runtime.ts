/**
 * Process and runtime events of the structured-log registry (`../logging.ts`): app lifecycle, configuration, the
 * database, diagnostics, E2E launches, the Extension Host, Desktop, GPU, IPC, the log writer, processes, the Renderer,
 * the Server connection and Server Core, updates, and the performance and process monitors.
 */
export const appLogEvents = {
    childProcessGone: 'app.child_process_gone',
    quitFailed: 'app.quit_failed',
    quitRequested: 'app.quit_requested',
    ready: 'app.ready',
    secondInstanceFocusFailed: 'app.second_instance_focus_failed',
    secondInstanceFocused: 'app.second_instance_focused',
    /**
     * One per launch: every startup milestone in Main-clock milliseconds, closed by the Workbench's first frame.
     */
    startupProfile: 'app.startup_profile',
    unsavedEditorsDecided: 'app.unsaved_editors_decided',
} as const;

export const configLogEvents = {
    loadFailed: 'configuration.load_failed',
    pollChangeFailed: 'configuration.poll_change_failed',
    settingsListenerFailed: 'configuration.settings_listener_failed',
    watchChangeFailed: 'configuration.watch_change_failed',
    watcherError: 'configuration.watcher.error',
    watcherReady: 'configuration.watcher.ready',
} as const;

export const databaseLogEvents = {
    sessionStateRepaired: 'db.session_state_repaired',
    /**
     * A Server-owned write advanced a Session state revision: the closed `reason` (`serviceWrite`, `rootFirstVisit`,
     * `terminalTabRepair`, `unreadableRepair`, `terminalCreated`, `terminalClosed`, `terminalMovedAway`,
     * `projectPruned`) and the stored `revision`. Client writes are not recorded per write.
     */
    sessionStateRevisionAdvanced: 'db.session_state_revision_advanced',
    /**
     * A Session state write rejected as stale: `currentRevision`, `writtenRevision`, and the last recorded write in
     * this Server Core lifetime as `lastWriteReason` (the closed reason, `clientWrite`, or `unrecorded`),
     * `lastWriteRevision`, and `lastWriteAgeMs`.
     */
    sessionStateStaleWrite: 'db.session_state_stale_write',
    sessionStateUnchanged: 'db.session_state_unchanged',
} as const;

export const diagnosticsLogEvents = {
    exported: 'diagnostics.exported',
} as const;

export const e2eLogEvents = {
    launch: 'e2e.launch',
    logInvalid: 'e2e.log_invalid',
} as const;

export const extensionHostLogEvents = {
    activated: 'extension_host.activated',
    activating: 'extension_host.activating',
    apiRequestFailed: 'extension_host.api_request_failed',
    catalogRebuildFailed: 'extension_host.catalog_rebuild_failed',
    contextRefreshFailed: 'extension_host.context_refresh_failed',
    discovered: 'extension_host.discovered',
    error: 'extension_host.error',
    exit: 'extension_host.exit',
    invalidMessage: 'extension_host.invalid_message',
    ready: 'extension_host.ready',
    restartExhausted: 'extension_host.restart_exhausted',
    restartFailed: 'extension_host.restart_failed',
    startFailed: 'extension_host.start_failed',
    uncaughtException: 'extension_host.uncaught_exception',
    unhandledRejection: 'extension_host.unhandled_rejection',
} as const;

export const desktopLogEvents = {
    uncaughtException: 'desktop.uncaught_exception',
    unhandledRejection: 'desktop.unhandled_rejection',
} as const;

export const gpuLogEvents = {
    processGone: 'gpu.process_gone',
    recovery: 'gpu.recovery',
    safeMode: 'gpu.safe_mode',
    sessionBudget: 'gpu.session_budget',
    snapshot: 'gpu.snapshot',
    snapshotFailed: 'gpu.snapshot_failed',
} as const;

export const ipcLogEvents = {
    request: 'ipc.request',
    requestFailed: 'ipc.request_failed',
} as const;

export const logLogEvents = {
    recordsDropped: 'log.records_dropped',
    rotated: 'log.rotated',
} as const;

export const processLogEvents = {
    eventLoopStall: 'process.event_loop_stall',
} as const;

/**
 * The Performance Monitor window's own Renderer lifecycle, kept apart from the Workbench's it measures. `reload`
 * records one observed Workbench load (its kind, outcome, and stage durations) so a slow reload is explained by stage,
 * not guessed from the total.
 */
export const performanceMonitorLogEvents = {
    consoleError: 'performance_monitor.console_error',
    pageException: 'performance_monitor.page_exception',
    preloadError: 'performance_monitor.preload_error',
    reload: 'performance_monitor.reload',
    renderProcessCrashLoop: 'performance_monitor.render_process_crash_loop',
    renderProcessGone: 'performance_monitor.render_process_gone',
    responsive: 'performance_monitor.responsive',
    unhandledRejection: 'performance_monitor.unhandled_rejection',
    unresponsive: 'performance_monitor.unresponsive',
} as const;

export const processExplorerLogEvents = {
    consoleError: 'process_explorer.console_error',
    pageException: 'process_explorer.page_exception',
    preloadError: 'process_explorer.preload_error',
    renderProcessCrashLoop: 'process_explorer.render_process_crash_loop',
    renderProcessGone: 'process_explorer.render_process_gone',
    responsive: 'process_explorer.responsive',
    sample: 'process_explorer.sample',
    unhandledRejection: 'process_explorer.unhandled_rejection',
    unresponsive: 'process_explorer.unresponsive',
} as const;

export const rendererLogEvents = {
    consoleError: 'renderer.console_error',
    editorWorkerStall: 'renderer.editor_worker_stall',
    jank: 'renderer.jank',
    pageException: 'renderer.page_exception',
    performanceScenario: 'renderer.performance_scenario',
    preloadError: 'renderer.preload_error',
    terminalOsc52ClipboardWriteFailed: 'renderer.terminal_osc52_clipboard_write_failed',
    terminalResizeBurst: 'renderer.terminal_resize_burst',
    terminalRendererStatus: 'renderer.terminal_renderer_status',
    unhandledRejection: 'renderer.unhandled_rejection',
} as const;

export const serverConnectionLogEvents = {
    attachFailed: 'server_connection.attach_failed',
    attached: 'server_connection.attached',
    connectionLost: 'server_connection.lost',
    desktopCommandCallbackRejected: 'server_connection.desktop_command_callback_rejected',
    desktopLeaseReplaced: 'server_connection.desktop_lease_replaced',
    desktopReadyFailed: 'server_connection.desktop_ready_failed',
    eventRecoveryFailed: 'server_connection.event_recovery_failed',
    reconnectFailed: 'server_connection.reconnect_failed',
    reconnected: 'server_connection.reconnected',
    staleBuildReplaced: 'server_connection.stale_build_replaced',
    versionMismatch: 'server_connection.version_mismatch',
} as const;

export const serverCoreLogEvents = {
    /**
     * The Agent CLI launcher (`<userData>/bin/caxri`) could not be written, so managed Agents get no `CAXRI_CLI`.
     */
    cliLauncherFailed: 'server_core.cli_launcher_failed',
    clientCount: 'server_core.client_count',
    commandReceipt: 'server_core.command_receipt',
    desktopLeaseGraceEntered: 'server_core.desktop_lease_grace_entered',
    desktopLeaseRecovered: 'server_core.desktop_lease_recovered',
    desktopLeaseRevoked: 'server_core.desktop_lease_revoked',
    domainsReady: 'server_core.domains_ready',
    eventRejected: 'server_core.event_rejected',
    eventRecovery: 'server_core.event_recovery',
    /**
     * One record per idle-exit recheck that found live work and postponed shutdown; see `ServerIdleExitDeferralReason`
     * for the closed cause and `docs/adr/0010-server-core-idle-exit.md` for the policy this defers.
     */
    idleExitDeferred: 'server_core.idle_exit_deferred',
    /**
     * The one record per idle-exit transition that actually stops the process; carries the closed
     * `ServerIdleExitReason`, the idle duration, and how many prior checks deferred during this idle window.
     */
    idleExitTriggered: 'server_core.idle_exit_triggered',
    /**
     * One record per machine-load transition: entering `loaded` carries the load per core that crossed the threshold;
     * leaving it carries the duration, peak, and per-`BackgroundWorkSource` deferred rounds.
     */
    loadChanged: 'server_core.load_changed',
    /**
     * Another account on a shared Linux machine held this profile's lock names; `outcome` is the closed result
     * (`acquired` past them or `exhausted`), `squattedNames` how many were skipped. See `linux-profile-lock.ts`.
     */
    profileLockSquatted: 'server_core.profile_lock_squatted',
    ready: 'server_core.ready',
    recoveryReady: 'server_core.recovery_ready',
    socketTerminated: 'server_core.socket_terminated',
    status: 'server_core.status',
    stopFailed: 'server_core.stop_failed',
    stopped: 'server_core.stopped',
    stopping: 'server_core.stopping',
    uncaughtException: 'server_core.uncaught_exception',
    unhandledRejection: 'server_core.unhandled_rejection',
} as const;

export const updatesLogEvents = {
    install: 'updates.install',
    state: 'updates.state',
} as const;
