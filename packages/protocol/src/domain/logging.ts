import { z } from 'zod';

/**
 * Canonical structured-log event registry. Writers use these values so adding or renaming an event is one reviewed,
 * browser-safe protocol change instead of an unchecked string scattered across Desktop processes.
 */
export const logEventCatalog = {
    agent: {
        integrationReconcileFailed: 'agent.integration_reconcile_failed',
        probe: 'agent.probe',
        probeFailed: 'agent.probe_failed',
        processProbeFailed: 'agent.process_probe_failed',
    },
    agentEndpoint: {
        retireFailed: 'agent_endpoint.retire_failed',
    },
    agentHooks: {
        initializeFailed: 'agent_hooks.initialize_failed',
        lockFailed: 'agent_hooks.lock_failed',
        reconcileFailed: 'agent_hooks.reconcile_failed',
        signalFailed: 'agent_hooks.signal_failed',
    },
    app: {
        childProcessGone: 'app.child_process_gone',
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
    },
    diagnostics: {
        exported: 'diagnostics.exported',
    },
    e2e: {
        launch: 'e2e.launch',
        logInvalid: 'e2e.log_invalid',
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
        summary: 'git.summary',
    },
    host: {
        attachFailed: 'host.attach_failed',
        attached: 'host.attached',
        clientCount: 'host.client_count',
        connectionLost: 'host.connection_lost',
        desktopLeaseReplaced: 'host.desktop_lease_replaced',
        desktopReadyFailed: 'host.desktop_ready_failed',
        eventRecoveryFailed: 'host.event_recovery_failed',
        ready: 'host.ready',
        reconnectFailed: 'host.reconnect_failed',
        reconnected: 'host.reconnected',
        runtimeChildError: 'host.runtime_child_error',
        runtimeExit: 'host.runtime_exit',
        runtimeMessageInvalid: 'host.runtime_message_invalid',
        staleBuildReplaced: 'host.stale_build_replaced',
        stopFailed: 'host.stop_failed',
        stopped: 'host.stopped',
        stopping: 'host.stopping',
        uncaughtException: 'host.uncaught_exception',
        unhandledRejection: 'host.unhandled_rejection',
        versionMismatch: 'host.version_mismatch',
    },
    ipc: {
        request: 'ipc.request',
        requestFailed: 'ipc.request_failed',
    },
    log: {
        recordsDropped: 'log.records_dropped',
    },
    main: {
        uncaughtException: 'main.uncaught_exception',
        unhandledRejection: 'main.unhandled_rejection',
    },
    process: {
        eventLoopStall: 'process.event_loop_stall',
    },
    processExplorer: {
        consoleError: 'process_explorer.console_error',
        pageException: 'process_explorer.page_exception',
        preloadError: 'process_explorer.preload_error',
        renderProcessCrashLoop: 'process_explorer.render_process_crash_loop',
        renderProcessGone: 'process_explorer.render_process_gone',
        sample: 'process_explorer.sample',
        unhandledRejection: 'process_explorer.unhandled_rejection',
    },
    projectStatus: {
        cli: 'project_status.cli',
        local: 'project_status.local',
        overviewGithubUnavailable: 'project_status.overview_github_unavailable',
        refresh: 'project_status.refresh',
        refreshFailed: 'project_status.refresh_failed',
        summary: 'project_status.summary',
    },
    pty: {
        attach: 'pty.attach',
        exitFinalizeFailed: 'pty.exit_finalize_failed',
        exited: 'pty.exited',
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
        throughput: 'pty.throughput',
    },
    renderer: {
        consoleError: 'renderer.console_error',
        pageException: 'renderer.page_exception',
        preloadError: 'renderer.preload_error',
        unhandledRejection: 'renderer.unhandled_rejection',
    },
    runtime: {
        ready: 'runtime.ready',
        status: 'runtime.status',
        uncaughtException: 'runtime.uncaught_exception',
        unhandledRejection: 'runtime.unhandled_rejection',
    },
    terminal: {
        humanSteer: 'terminal.human_steer',
        restoreCwdRejected: 'terminal.restore_cwd_rejected',
        restoreInterruptedFailed: 'terminal.restore_interrupted_failed',
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
        pollFailed: 'watch_hub.poll_failed',
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
    },
    workbenchRoot: {
        fallback: 'workbench_root.fallback',
        provenancePrimed: 'workbench_root.provenance_primed',
        provenanceUnavailable: 'workbench_root.provenance_unavailable',
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
