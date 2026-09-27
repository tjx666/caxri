import { z } from 'zod';

/**
 * Canonical structured-log event registry. Writers use these values so adding or renaming an event is one reviewed,
 * browser-safe protocol change instead of an unchecked string scattered across Desktop processes.
 */
export const logEventCatalog = {
    mobileGateway: {
        sessionReadSummary: 'mobile_gateway.session_read_summary',
        failure: 'mobile_gateway.failure',
        failureSummary: 'mobile_gateway.failure_summary',
        terminalResyncSummary: 'mobile_gateway.terminal_resync_summary',
    },
    agent: {
        automaticNamingFinished: 'agent.automatic_naming_finished',
        hookTurnExpired: 'agent.hook_turn_expired',
        hookTurnInterrupted: 'agent.hook_turn_interrupted',
        integrationReconcileFailed: 'agent.integration_reconcile_failed',
        /**
         * Grant/revoke transition for the Session-scoped "Always allow in this Session" permission auto-allow (issue
         * caxri#1295). Carries a closed `reason` enum (`'user' | 'agentRestart' | 'sessionDeleted'`) instead of a bare
         * boolean, per the diagnostics invariant that a state change must record why it happened.
         */
        permissionAutoAllowChanged: 'agent.permission_auto_allow_changed',
        /**
         * One entry per auto-allowed permission request. Never logs request content — only the Session/Terminal id,
         * tool name, and the running per-Session grant lifetime count.
         */
        permissionAutoAllowed: 'agent.permission_auto_allowed',
        probe: 'agent.probe',
        probeFailed: 'agent.probe_failed',
        processProbeFailed: 'agent.process_probe_failed',
        sessionActivityChanged: 'agent.session_activity_changed',
    },
    agentDelegation: {
        admissionRejected: 'agent_delegation.admission_rejected',
    },
    agentDispatch: {
        transitioned: 'agent_dispatch.transitioned',
    },
    agentEndpoint: {
        retireFailed: 'agent_endpoint.retire_failed',
    },
    agentHooks: {
        bridgeStarted: 'agent_hooks.bridge_started',
        configWritten: 'agent_hooks.config_written',
        executableMissing: 'agent_hooks.executable_missing',
        healthChanged: 'agent_hooks.health_changed',
        initializeFailed: 'agent_hooks.initialize_failed',
        launchPrepared: 'agent_hooks.launch_prepared',
        launchSummary: 'agent_hooks.launch_summary',
        lockFailed: 'agent_hooks.lock_failed',
        reconcileFailed: 'agent_hooks.reconcile_failed',
        repairNotConverged: 'agent_hooks.repair_not_converged',
        signalAccepted: 'agent_hooks.signal_accepted',
        signalFailed: 'agent_hooks.signal_failed',
        signalIgnored: 'agent_hooks.signal_ignored',
        signalRejected: 'agent_hooks.signal_rejected',
    },
    agentNotifications: {
        decided: 'agent_notifications.decided',
        deliveryFallback: 'agent_notifications.delivery_fallback',
        operationFailed: 'agent_notifications.operation_failed',
        settingsRefreshSuppressed: 'agent_notifications.settings_refresh_suppressed',
    },
    app: {
        childProcessGone: 'app.child_process_gone',
        quitFailed: 'app.quit_failed',
        quitRequested: 'app.quit_requested',
        ready: 'app.ready',
        secondInstanceFocusFailed: 'app.second_instance_focus_failed',
        secondInstanceFocused: 'app.second_instance_focused',
    },
    configuration: {
        loadFailed: 'configuration.load_failed',
        pollChangeFailed: 'configuration.poll_change_failed',
        watchChangeFailed: 'configuration.watch_change_failed',
        watcherError: 'configuration.watcher.error',
        watcherReady: 'configuration.watcher.ready',
    },
    database: {
        sessionStateRepaired: 'db.session_state_repaired',
        sessionStateUnchanged: 'db.session_state_unchanged',
    },
    diagnostics: {
        exported: 'diagnostics.exported',
    },
    e2e: {
        launch: 'e2e.launch',
        logInvalid: 'e2e.log_invalid',
    },
    extensionHost: {
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
    },
    file: {
        browse: 'file.browse',
        copied: 'file.copied',
        copyFailed: 'file.copy_failed',
        copyPartialPreserved: 'file.copy_partial_preserved',
        created: 'file.created',
        gitIgnoreUnavailable: 'file.git_ignore_unavailable',
        list: 'file.list',
        listEntrySkipped: 'file.list_entry_skipped',
        moved: 'file.moved',
        operationCancelFailed: 'file.operation_cancel_failed',
        operationCompletionPending: 'file.operation_completion_pending',
        operationCompletionRetry: 'file.operation_completion_retry',
        operationCompletionRetryFailed: 'file.operation_completion_retry_failed',
        operationPhase: 'file.operation_phase',
        operationRecovered: 'file.operation_recovered',
        saved: 'file.saved',
        search: 'file.search',
        symlinkProbeBudgetSpent: 'file.symlink_probe_budget_spent',
        searchEntrySkipped: 'file.search_entry_skipped',
    },
    files: {
        refreshWatchSessionFailed: 'files.refresh_watch_session_failed',
        watchSessionFailed: 'files.watch_session_failed',
    },
    git: {
        command: 'git.command',
        commandFailed: 'git.command_failed',
        githubCommand: 'git.github_command',
        githubCommandFailed: 'git.github_command_failed',
        metadataWatcherReady: 'git.metadata_watcher_ready',
        refreshSummary: 'git.refresh_summary',
        summary: 'git.summary',
    },
    desktop: {
        uncaughtException: 'desktop.uncaught_exception',
        unhandledRejection: 'desktop.unhandled_rejection',
    },
    externalStatus: {
        paused: 'external_status.paused',
        quota: 'external_status.quota',
        resumed: 'external_status.resumed',
    },
    gpu: {
        processGone: 'gpu.process_gone',
        recovery: 'gpu.recovery',
        safeMode: 'gpu.safe_mode',
        sessionBudget: 'gpu.session_budget',
        snapshot: 'gpu.snapshot',
        snapshotFailed: 'gpu.snapshot_failed',
    },
    ipc: {
        request: 'ipc.request',
        requestFailed: 'ipc.request_failed',
    },
    log: {
        recordsDropped: 'log.records_dropped',
        rotated: 'log.rotated',
    },
    process: {
        eventLoopStall: 'process.event_loop_stall',
    },
    agentCommander: {
        consoleError: 'agent_commander.console_error',
        pageException: 'agent_commander.page_exception',
        preloadError: 'agent_commander.preload_error',
        renderProcessCrashLoop: 'agent_commander.render_process_crash_loop',
        renderProcessGone: 'agent_commander.render_process_gone',
        requestDenied: 'agent_commander.request_denied',
        responsive: 'agent_commander.responsive',
        unhandledRejection: 'agent_commander.unhandled_rejection',
        unresponsive: 'agent_commander.unresponsive',
    },
    processExplorer: {
        consoleError: 'process_explorer.console_error',
        pageException: 'process_explorer.page_exception',
        preloadError: 'process_explorer.preload_error',
        renderProcessCrashLoop: 'process_explorer.render_process_crash_loop',
        renderProcessGone: 'process_explorer.render_process_gone',
        responsive: 'process_explorer.responsive',
        sample: 'process_explorer.sample',
        unhandledRejection: 'process_explorer.unhandled_rejection',
        unresponsive: 'process_explorer.unresponsive',
    },
    projectStatus: {
        alert: 'project_status.alert',
        cli: 'project_status.cli',
        cliSummary: 'project_status.cli_summary',
        local: 'project_status.local',
        notifyFailed: 'project_status.notify_failed',
        overviewGithubUnavailable: 'project_status.overview_github_unavailable',
        poll: 'project_status.poll',
        refresh: 'project_status.refresh',
        refreshFailed: 'project_status.refresh_failed',
        summary: 'project_status.summary',
        watch: 'project_status.watch',
    },
    sessionCompaction: {
        checked: 'session.compaction_checked',
    },
    sessionRename: {
        providerSyncSkipped: 'session_rename.provider_sync_skipped',
        providerTitleMismatch: 'session_rename.provider_title_mismatch',
    },
    sessionPullRequests: {
        cli: 'session_pull_requests.cli',
        cliSummary: 'session_pull_requests.cli_summary',
        focusRefresh: 'session_pull_requests.focus_refresh',
        lookupUnavailable: 'session_pull_requests.lookup_unavailable',
        refresh: 'session_pull_requests.refresh',
        refreshFailed: 'session_pull_requests.refresh_failed',
    },
    pty: {
        attach: 'pty.attach',
        exitFinalizeFailed: 'pty.exit_finalize_failed',
        exited: 'pty.exited',
        firstInput: 'pty.first_input',
        lifecycleRetireFailed: 'pty.lifecycle_retire_failed',
        outputRecoveryCancelled: 'pty.output_recovery_cancelled',
        outputRecoveryCompleted: 'pty.output_recovery_completed',
        outputRecoveryEvaluateFailed: 'pty.output_recovery_evaluate_failed',
        outputRecoveryRateLimited: 'pty.output_recovery_rate_limited',
        outputRecoveryRearmTailFailed: 'pty.output_recovery_rearm_tail_failed',
        outputRecoveryTailFailed: 'pty.output_recovery_tail_failed',
        screenBackpressure: 'pty.screen_backpressure',
        shellIntegrationUnavailable: 'pty.shell_integration_unavailable',
        snapshotFailed: 'pty.snapshot_failed',
        spawnFailed: 'pty.spawn_failed',
        spawned: 'pty.spawned',
        resizeBurst: 'pty.resize_burst',
        throughput: 'pty.throughput',
        throughputSummary: 'pty.throughput_summary',
    },
    renderer: {
        consoleError: 'renderer.console_error',
        editorWorkerStall: 'renderer.editor_worker_stall',
        pageException: 'renderer.page_exception',
        performanceScenario: 'renderer.performance_scenario',
        preloadError: 'renderer.preload_error',
        terminalOsc52ClipboardWriteFailed: 'renderer.terminal_osc52_clipboard_write_failed',
        terminalResizeBurst: 'renderer.terminal_resize_burst',
        terminalRendererStatus: 'renderer.terminal_renderer_status',
        unhandledRejection: 'renderer.unhandled_rejection',
    },
    serverConnection: {
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
    },
    serverCore: {
        clientCount: 'server_core.client_count',
        commandReceipt: 'server_core.command_receipt',
        desktopLeaseGraceEntered: 'server_core.desktop_lease_grace_entered',
        desktopLeaseRecovered: 'server_core.desktop_lease_recovered',
        desktopLeaseRevoked: 'server_core.desktop_lease_revoked',
        domainsReady: 'server_core.domains_ready',
        eventRejected: 'server_core.event_rejected',
        eventRecovery: 'server_core.event_recovery',
        ready: 'server_core.ready',
        recoveryReady: 'server_core.recovery_ready',
        socketTerminated: 'server_core.socket_terminated',
        status: 'server_core.status',
        stopFailed: 'server_core.stop_failed',
        stopped: 'server_core.stopped',
        stopping: 'server_core.stopping',
        uncaughtException: 'server_core.uncaught_exception',
        unhandledRejection: 'server_core.unhandled_rejection',
    },
    terminal: {
        humanSteer: 'terminal.human_steer',
        restoreCwdRejected: 'terminal.restore_cwd_rejected',
        restoreInterruptedFailed: 'terminal.restore_interrupted_failed',
        suspendFailed: 'terminal.suspend_failed',
        suspended: 'terminal.suspended',
    },
    terminalHost: {
        attachFailed: 'terminal_host.attach_failed',
        error: 'terminal_host.error',
        exited: 'terminal_host.exited',
        invalidMessage: 'terminal_host.invalid_message',
        ready: 'terminal_host.ready',
        requestFailed: 'terminal_host.request_failed',
        requestTimeout: 'terminal_host.request_timeout',
        shutdownFailed: 'terminal_host.shutdown_failed',
        started: 'terminal_host.started',
        stopped: 'terminal_host.stopped',
        uncaughtException: 'terminal_host.uncaught_exception',
        unhandledRejection: 'terminal_host.unhandled_rejection',
    },
    updates: {
        state: 'updates.state',
    },
    watcher: {
        batch: 'watcher.batch',
        fallback: 'watcher.fallback',
        ready: 'watcher.ready',
        setupFailed: 'watcher.setup_failed',
        signatureEntrySkipped: 'watcher.signature_entry_skipped',
    },
    watchHub: {
        fallback: 'watch_hub.fallback',
        fallbackActivationFailed: 'watch_hub.fallback_activation_failed',
        nativeGate: 'watch_hub.native_gate',
        nativePressure: 'watch_hub.native_pressure',
        nativeRestored: 'watch_hub.native_restored',
        pollFailed: 'watch_hub.poll_failed',
        rescan: 'watch_hub.rescan',
        subscribeFailed: 'watch_hub.subscribe_failed',
        watcherError: 'watch_hub.watcher_error',
    },
    window: {
        closeConfirmation: 'window.close_confirmation',
        closeDecision: 'window.close_decision',
        closeFailed: 'window.close_failed',
        closed: 'window.closed',
        created: 'window.created',
        readyToShow: 'window.ready_to_show',
        renderProcessCrashLoop: 'window.render_process_crash_loop',
        renderProcessGone: 'window.render_process_gone',
        responsive: 'window.responsive',
        unresponsive: 'window.unresponsive',
    },
    workbenchRoot: {
        fallback: 'workbench_root.fallback',
        provenancePrimed: 'workbench_root.provenance_primed',
        provenanceUnavailable: 'workbench_root.provenance_unavailable',
        rebound: 'workbench_root.rebound',
        selected: 'workbench_root.selected',
        topologyFailed: 'workbench_root.topology_failed',
        validationDropped: 'workbench_root.validation_dropped',
    },
    workbenchRoots: {
        validateSessionFailed: 'workbench_roots.validate_session_failed',
    },
} as const;

export type LogEventName = {
    [
        Group in keyof typeof logEventCatalog
    ]: (typeof logEventCatalog)[Group][keyof (typeof logEventCatalog)[Group]];
}[keyof typeof logEventCatalog];

export const logEventNames = Object.values(logEventCatalog).flatMap((group) =>
    Object.values(group),
) as [LogEventName, ...LogEventName[]];

export const logEventNameSchema = z.enum(logEventNames);

/**
 * Closed reason set for `session_rename.provider_sync_skipped`. Skipping the provider write is ordinary behavior — a
 * Session title belongs to Caxri, so the rename always commits locally — which is exactly why the two causes have to
 * stay apart in logs: an Agent that has not reported a session id yet will start synchronizing once it does, while a
 * provider with no rename integration never will. Collapsing them into one string would hide a provider gap inside
 * normal new-Session noise.
 */
export type SessionRenameProviderSyncSkipReason =
    'agent-session-unidentified' | 'provider-rename-unsupported';
