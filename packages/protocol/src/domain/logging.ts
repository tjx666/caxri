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
        /**
         * One record per Android update download request, with a closed `outcome`, served bytes, and duration.
         */
        updateDownload: 'mobile_gateway.update_download',
        /**
         * One record per update-recovery exchange from a phone whose transport version no longer matches, with a closed
         * `outcome`.
         */
        updateRecovery: 'mobile_gateway.update_recovery',
        enabled: 'mobile_gateway.enabled',
        disabled: 'mobile_gateway.disabled',
        /**
         * The remembered mobile-access switch: `restored` or `restore-failed` when a Server start reopens the gateway,
         * `write-failed` when the owner's switch could not be saved for the next start.
         */
        accessPersistence: 'mobile_gateway.access_persistence',
        connectionEstablished: 'mobile_gateway.connection_established',
        connectionEnded: 'mobile_gateway.connection_ended',
        pairingOutcome: 'mobile_gateway.pairing_outcome',
        pairingSummary: 'mobile_gateway.pairing_summary',
    },
    agentChat: {
        /**
         * Provider process start outcome with a closed `outcome`/`reason`, the resume mode, and the handshake duration.
         */
        processStarted: 'agent_chat.process_started',
        /**
         * Provider process exit with the lifetime aggregates (turns, server requests, dropped frames, unknown methods)
         * and whether Caxri asked it to stop. Never carries stderr or protocol bodies.
         */
        processExited: 'agent_chat.process_exited',
        /**
         * One record per finished turn with its closed status and duration.
         */
        turnFinished: 'agent_chat.turn_finished',
        /**
         * A provider request or response Caxri could not honor, with a closed `reason`.
         */
        protocolRejected: 'agent_chat.protocol_rejected',
        /**
         * A follow-up message queue transition with a closed `reason` (`queued`, `steered`, `dispatched`, `removed`,
         * `sentNow`, `paused`, `resumed`, `dispatchFailed`, `deliveryUnknown`) and the queue depth after it. Never
         * carries message text.
         */
        queueChanged: 'agent_chat.queue_changed',
        /**
         * A request that starts or steers a turn timed out and Caxri checked whether the provider recorded the input
         * anyway, with the request `method` and a closed `outcome` (`delivered`, `unknown`). Never carries message
         * text.
         */
        deliveryChecked: 'agent_chat.delivery_checked',
        /**
         * A subagent or background shell reached a final status, with its `kind`, closed `status`, and duration.
         */
        taskFinished: 'agent_chat.task_finished',
        /**
         * One "Edit from here" with a closed `outcome` (`rewound`, `refused`, `failed`), the provider, whether files
         * were restored, the turns removed, and the duration through the restart. Never carries message text or paths.
         */
        rewound: 'agent_chat.rewound',
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
         * One entry per auto-allowed permission request. Never logs request content, only the Session/Terminal id, tool
         * name, and the running per-Session grant lifetime count.
         */
        permissionAutoAllowed: 'agent.permission_auto_allowed',
        probe: 'agent.probe',
        /**
         * One record per user-requested Session title suggestion with a closed `reason` and duration. Never carries the
         * transcript, prompt, or generated title.
         */
        titleSuggestionFinished: 'agent.title_suggestion_finished',
        probeFailed: 'agent.probe_failed',
        processProbeFailed: 'agent.process_probe_failed',
        sessionActivityChanged: 'agent.session_activity_changed',
    },
    agentDelegation: {
        admissionRejected: 'agent_delegation.admission_rejected',
        /**
         * A task was admitted. Carries how it targets its Session (`mode`: new, follow-up, or resume; `newSession`),
         * whether the Agent Commander sent it, and the request's correlation ID, so a delegation can be traced back to
         * the CLI call that created it. Never the prompt.
         */
        requested: 'agent_delegation.requested',
        /**
         * A task's receipt `status` or `failure` changed: the delegation lifecycle as a sequence of state transitions,
         * with the previous status and the time since the task was created. Receipt state only, never prompt or
         * answer.
         */
        transitioned: 'agent_delegation.transitioned',
    },
    agentDispatch: {
        transitioned: 'agent_dispatch.transitioned',
    },
    agentEndpoint: {
        messagingChangedListenerFailed: 'agent_endpoint.messaging_changed_listener_failed',
        retireFailed: 'agent_endpoint.retire_failed',
        retiredListenerFailed: 'agent_endpoint.retired_listener_failed',
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
        /**
         * One per launch: every startup milestone in Main-clock milliseconds, closed by the Workbench's first frame.
         */
        startupProfile: 'app.startup_profile',
    },
    configuration: {
        loadFailed: 'configuration.load_failed',
        pollChangeFailed: 'configuration.poll_change_failed',
        settingsListenerFailed: 'configuration.settings_listener_failed',
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
        mergeAgentNotice: 'git.merge_agent_notice',
        metadataWatcherReady: 'git.metadata_watcher_ready',
        refreshSummary: 'git.refresh_summary',
        summary: 'git.summary',
    },
    desktop: {
        uncaughtException: 'desktop.uncaught_exception',
        unhandledRejection: 'desktop.unhandled_rejection',
    },
    externalStatus: {
        /**
         * Main could not read an Agent provider's public status page. `fields.provider` and the closed `fields.reason`
         * (`AgentProviderStatusFailureReason`) say which page and why; a page that answers again writes
         * `external_status.provider_status_recovered`.
         */
        providerStatusFailed: 'external_status.provider_status_failed',
        providerStatusRecovered: 'external_status.provider_status_recovered',
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
    pathBrowser: {
        /**
         * One record per `pathBrowser.browse` call that ran the Project-wide name search (memo hit or a fresh
         * `files.search`), success or not. `file.search` already covers Server Core's own view of the scan; this event
         * covers what Main did with the result: the memo/root-containment/budget steps a slow or missing search engine
         * would otherwise hide behind an unremarkable empty result. See issue caxri#924.
         */
        searchFallback: 'path_browser.search_fallback',
        /**
         * The Project-wide name search could not run at all. Carries `PathBrowserSearchFailureReason` instead of the
         * thrown error's message so a packaged install missing ripgrep reads as a diagnosable reason, not as silence.
         */
        searchFailed: 'path_browser.search_failed',
    },
    process: {
        eventLoopStall: 'process.event_loop_stall',
    },
    agentCommander: {
        consoleError: 'agent_commander.console_error',
        /**
         * `commander.ensure` finished. `fields.outcome` is `created` (a new Commander Terminal), `restored` (an
         * interrupted, suspended, or stopped one was resumed), or `running` (nothing to do), with its duration.
         */
        ensured: 'agent_commander.ensured',
        /**
         * The Commander created a Session to delegate into, or removed one a refused delegation never used.
         */
        sessionCreated: 'agent_commander.session_created',
        sessionDiscarded: 'agent_commander.session_discarded',
        /**
         * `commander.stop` parked the Commander Terminal. `fields.outcome` is `stopped` or `not_running`.
         */
        stopped: 'agent_commander.stopped',
        /**
         * A coalesced batch of delegation completion notices was injected into the Commander Terminal. `fields.count`
         * is the number of delegations the single line reports, so this also measures how often coalescing fires.
         */
        completionNoticeDelivered: 'agent_commander.completion_notice_delivered',
        /**
         * Pending notices are held back by a delivery gate. `fields.reason` is a closed
         * `CommanderCompletionNoticeDeferral`, logged once per gate change for the current batch.
         */
        completionNoticeDeferred: 'agent_commander.completion_notice_deferred',
        /**
         * A delegation transition was queued for the Commander Terminal, with the batch's size after queueing.
         */
        completionNoticeQueued: 'agent_commander.completion_notice_queued',
        /**
         * A completion notice batch was consumed (so it will never be retried) but its PTY write was rejected or its
         * delivery could not be confirmed. Carries a closed `fields.reason`
         * (`CommanderCompletionNoticeDeliveryFailure`) distinguishing the two; a gate that simply is not satisfied yet
         * (a draft, a busy Commander) is not a failure; it is `completionNoticeDeferred` at debug level and resolves
         * itself on the next idle point.
         */
        completionNoticeDeliveryFailed: 'agent_commander.completion_notice_delivery_failed',
        /**
         * Pending notices were discarded unsent. `fields.reason` is a closed `CommanderCompletionNoticeDropReason`
         * (`server_shutdown`), with the discarded `count`, the oldest entry's `waitMs`, the `blockedTurns` that could
         * not take the batch, and the `lastDeferral` gate that held it.
         */
        completionNoticeDropped: 'agent_commander.completion_notice_dropped',
        pageException: 'agent_commander.page_exception',
        preloadError: 'agent_commander.preload_error',
        renderProcessCrashLoop: 'agent_commander.render_process_crash_loop',
        renderProcessGone: 'agent_commander.render_process_gone',
        requestDenied: 'agent_commander.request_denied',
        responsive: 'agent_commander.responsive',
        stopFailed: 'agent_commander.stop_failed',
        unhandledRejection: 'agent_commander.unhandled_rejection',
        unresponsive: 'agent_commander.unresponsive',
        workspaceRepositoryFailed: 'agent_commander.workspace_repository_failed',
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
    /**
     * `SessionContextService`'s incremental Agent-transcript scan (issue caxri#1032): the same reader the Workbench
     * Root picker, the status bar's Linear chip, and `SessionPullRequestService` all share.
     */
    sessionContext: {
        /**
         * One scan pass produced nothing. Carries a closed `fields.reason` (`TranscriptScanFailureReason` from
         * `apps/server/src/domains/agents/transcript-security.ts`) so a routine capability miss (`missing`, before an
         * Agent's first line) never looks like a security rejection or an IO failure in the log.
         */
        scanFailed: 'session_context.scan_failed',
        /**
         * The provider rewrote a transcript below the cursor, so the scan restarted from byte zero. A state transition,
         * not a failure: recorded so a shrinking transcript is visible without waiting for the windowed aggregate
         * below.
         */
        cursorReset: 'session_context.cursor_reset',
        /**
         * One aggregate per Session per window: scan count, total/max duration, and approximate bytes scanned, so this
         * every-60-seconds-per-visible-Session path stays answerable without a per-poll record.
         */
        scanWindow: 'session_context.scan_window',
    },
    sessionRename: {
        providerSyncSkipped: 'session_rename.provider_sync_skipped',
        providerTitleMismatch: 'session_rename.provider_title_mismatch',
    },
    usage: {
        externalScan: 'usage.external_scan',
        pricing: 'usage.pricing',
        pullRequests: 'usage.pull_requests',
        scan: 'usage.scan',
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
        /**
         * One record per idle-exit recheck that found live work and postponed shutdown; see
         * `ServerIdleExitDeferralReason` for the closed cause and `docs/adr/0010-server-core-idle-exit.md` for the
         * policy this defers.
         */
        idleExitDeferred: 'server_core.idle_exit_deferred',
        /**
         * The one record per idle-exit transition that actually stops the process; carries the closed
         * `ServerIdleExitReason`, the idle duration, and how many prior checks deferred during this idle window.
         */
        idleExitTriggered: 'server_core.idle_exit_triggered',
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
        resourceAlertCleared: 'terminal.resource_alert_cleared',
        resourceAlertRaised: 'terminal.resource_alert_raised',
        resourceSampleFailed: 'terminal.resource_sample_failed',
        restoreCwdRejected: 'terminal.restore_cwd_rejected',
        restoreInterruptedFailed: 'terminal.restore_interrupted_failed',
        resumeSkipped: 'terminal.resume_skipped',
        suspendFailed: 'terminal.suspend_failed',
        suspended: 'terminal.suspended',
        /**
         * One `terminal.switchSurface` request: the closed `outcome` (`switched`, `startedNew` for an Agent with no
         * conversation to carry over, `turnRunning`, `failed`), both surfaces, the provider, whether a running turn was
         * interrupted, and the duration.
         */
        surfaceSwitched: 'terminal.surface_switched',
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
