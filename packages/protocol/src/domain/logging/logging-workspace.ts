/**
 * Workspace events of the structured-log registry (`../logging.ts`): files, Git, external and Project status, file
 * watching, and Workbench roots.
 */
export const fileLogEvents = {
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
} as const;

export const filesLogEvents = {
    refreshWatchSessionFailed: 'files.refresh_watch_session_failed',
    watchSessionFailed: 'files.watch_session_failed',
} as const;

export const gitLogEvents = {
    command: 'git.command',
    commandFailed: 'git.command_failed',
    githubCommand: 'git.github_command',
    githubCommandFailed: 'git.github_command_failed',
    mergeAgentNotice: 'git.merge_agent_notice',
    metadataWatcherReady: 'git.metadata_watcher_ready',
    refreshSummary: 'git.refresh_summary',
    summary: 'git.summary',
} as const;

export const externalStatusLogEvents = {
    /**
     * Main could not read an Agent provider's public status page. `fields.provider` and the closed `fields.reason`
     * (`AgentProviderStatusFailureReason`) say which page and why; a page that answers again writes
     * `external_status.provider_status_recovered`.
     */
    providerStatusFailed: 'external_status.provider_status_failed',
    providerStatusRecovered: 'external_status.provider_status_recovered',
    /**
     * The page's current state was read but its uptime history was not, so the status tab draws no uptime strip.
     * Written once per change of the closed `fields.reason`; `external_status.provider_history_recovered` follows when
     * the history reads again.
     */
    providerHistoryFailed: 'external_status.provider_history_failed',
    providerHistoryRecovered: 'external_status.provider_history_recovered',
    /**
     * Main could not read the Codex global reset tracker, so the status bar shows no reset countdown. Written once per
     * change of the closed `fields.reason` (`CodexGlobalResetFailureReason`);
     * `external_status.codex_global_reset_recovered` follows when the tracker answers again.
     */
    codexGlobalResetFailed: 'external_status.codex_global_reset_failed',
    codexGlobalResetRecovered: 'external_status.codex_global_reset_recovered',
    paused: 'external_status.paused',
    quota: 'external_status.quota',
    resumed: 'external_status.resumed',
} as const;

export const projectStatusLogEvents = {
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
} as const;

export const watcherLogEvents = {
    batch: 'watcher.batch',
    fallback: 'watcher.fallback',
    ready: 'watcher.ready',
    setupFailed: 'watcher.setup_failed',
    signatureEntrySkipped: 'watcher.signature_entry_skipped',
} as const;

export const watchHubLogEvents = {
    fallback: 'watch_hub.fallback',
    fallbackActivationFailed: 'watch_hub.fallback_activation_failed',
    nativeGate: 'watch_hub.native_gate',
    nativePressure: 'watch_hub.native_pressure',
    nativeRestored: 'watch_hub.native_restored',
    pollFailed: 'watch_hub.poll_failed',
    rescan: 'watch_hub.rescan',
    subscribeFailed: 'watch_hub.subscribe_failed',
    watcherError: 'watch_hub.watcher_error',
} as const;

export const workbenchSnapshotLogEvents = {
    built: 'workbench_snapshot.built',
} as const;

export const workbenchRootLogEvents = {
    fallback: 'workbench_root.fallback',
    provenancePrimed: 'workbench_root.provenance_primed',
    provenanceUnavailable: 'workbench_root.provenance_unavailable',
    rebound: 'workbench_root.rebound',
    selected: 'workbench_root.selected',
    sweepSlow: 'workbench_root.sweep_slow',
    topologyFailed: 'workbench_root.topology_failed',
    validationDropped: 'workbench_root.validation_dropped',
    worktreeArchiveCleanup: 'workbench_root.worktree_archive_cleanup',
} as const;

export const workbenchRootsLogEvents = {
    validateSessionFailed: 'workbench_roots.validate_session_failed',
} as const;
