/**
 * Agent events of the structured-log registry (`logEventCatalog.agentChat`, `agent`, and the other `agent*` groups in
 * `../logging.ts`): Agent Chat processes and turns, Agent detection, delegation, dispatch, endpoints, Hooks, and
 * notifications.
 */
export const agentChatLogEvents = {
    /**
     * Provider process start outcome with a closed `outcome`/`reason` (`refused`/`capacity` when the Terminal limit
     * stopped the start), the resume mode, and the handshake duration.
     */
    processStarted: 'agent_chat.process_started',
    /**
     * Provider process exit with the lifetime aggregates (turns, server requests, dropped frames, unknown methods) and
     * whether Caxri asked it to stop. Never carries stderr or protocol bodies.
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
     * `sentNow`, `paused`, `resumed`, `dispatchFailed`, `deliveryUnknown`) and the queue depth after it. Never carries
     * message text.
     */
    queueChanged: 'agent_chat.queue_changed',
    /**
     * A request that starts or steers a turn timed out and Caxri checked whether the provider recorded the input
     * anyway, with the request `method` and a closed `outcome` (`delivered`, `unknown`). Never carries message text.
     */
    deliveryChecked: 'agent_chat.delivery_checked',
    /**
     * A subagent or background shell reached a final status, with its `kind`, closed `status`, and duration.
     */
    taskFinished: 'agent_chat.task_finished',
    /**
     * After the user stopped a subagent, whether Caxri told the main Agent so its wait ends, with a closed `outcome`
     * (`steered`, `notWaiting` when the turn was not waiting on subagents, `turnEnded` when the turn ended before the
     * note arrived, `failed`). Never carries message text.
     */
    taskStopNoticed: 'agent_chat.task_stop_noticed',
    /**
     * One "Edit from here" with a closed `outcome` (`rewound`, `refused`, `failed`, or `resendFailed` when the record
     * was rewound but the restart or the edited message's send failed), a closed `reason` for a refusal or capability
     * failure (`capability`, `turnRunning`, `notTurnStart`, `unknownMessage`, else null), the error `code` (null on
     * success), the provider, whether files were restored, the turns removed, and the duration through the restart and
     * the send. Never carries message text or paths.
     */
    rewound: 'agent_chat.rewound',
    /**
     * One "Fork from here" with a closed `outcome` (`forked`, `refused`, `failed`), the error `code` when it did not
     * fork, the provider, the turns the fork keeps, `skippedRecords` (the malformed transcript lines a provider that
     * reads its own record skipped, Claude Code only, else null), whether a failure left the provider's forked record
     * `orphaned` (written, but no Session opens it), and the duration through creating the new Session. Never carries
     * message text or paths.
     */
    forked: 'agent_chat.forked',
    /**
     * A fork succeeded but the provider could not release the forked conversation it also loaded (Codex
     * `thread/unsubscribe`), with a closed `reason` (`rejected`, `timedOut`, `stopped`).
     */
    forkReleaseFailed: 'agent_chat.fork_release_failed',
    /**
     * A model, effort, or Fast mode switch from the picker saved as the provider's default for new Chats (Codex
     * `config/batchWrite`), with a closed `outcome` (`saved`, `overridden` when a higher-priority config layer still
     * wins, `failed`), the provider, and the comma-joined config `keys` it wrote. Never carries the values.
     */
    defaultsSaved: 'agent_chat.defaults_saved',
    /**
     * One side question (`/btw`) with a closed `outcome` (`answered`, `refused`, `failed`), a closed `reason` when it
     * was not answered (`unsupported`, `notRunning`, `timeout`, `empty`, `providerError`, else null), the provider, how
     * many earlier exchanges it carried (`historyLength`), and the duration. Never carries question or answer text.
     */
    sideQuestion: 'agent_chat.side_question',
    /**
     * One "Restore code to here" with a closed `outcome` (`restored`, `refused`, `failed`), a closed `reason` for a
     * refusal or capability failure (`capability`, `turnRunning`, `notTurnStart`, `unknownMessage`, else null), the
     * error `code` (null on success), the provider, the turns whose file changes were undone, and the duration. Never
     * carries message text or paths.
     */
    filesRestored: 'agent_chat.files_restored',
    /**
     * Server Core's startup sweep of provider process groups a previous lifetime left behind (killed before it could
     * reap them): how many were `recorded`, how many it stopped (`reaped`), found already empty (`gone`), or refused
     * because the group ID now belongs to a different process group (`reused`), and the duration. Never carries paths
     * or commands.
     */
    staleGroupsReaped: 'agent_chat.stale_groups_reaped',
} as const;

export const agentLogEvents = {
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
} as const;

export const agentDelegationLogEvents = {
    admissionRejected: 'agent_delegation.admission_rejected',
    /**
     * A task was admitted. Carries how it targets its Session (`mode`: new, follow-up, or resume; `newSession`),
     * whether the Agent Commander sent it, and the request's correlation ID, so a delegation can be traced back to the
     * CLI call that created it. Never the prompt.
     */
    requested: 'agent_delegation.requested',
    /**
     * A task's receipt `status` or `failure` changed: the delegation lifecycle as a sequence of state transitions, with
     * the previous status and the time since the task was created. Receipt state only, never prompt or answer.
     */
    transitioned: 'agent_delegation.transitioned',
} as const;

export const agentDispatchLogEvents = {
    /**
     * Preparing a Claude Code launch marked its working directory trusted in Claude Code's config. `fields.outcome` is
     * the closed `ClaudeFolderTrustOutcome`; anything but `granted` or `already_trusted` means the Agent opens on
     * Claude Code's trust prompt and the task waits at startup.
     */
    claudeTrustPrepared: 'agent_dispatch.claude_trust_prepared',
    transitioned: 'agent_dispatch.transitioned',
} as const;

export const agentEndpointLogEvents = {
    messagingChangedListenerFailed: 'agent_endpoint.messaging_changed_listener_failed',
    retireFailed: 'agent_endpoint.retire_failed',
    retiredListenerFailed: 'agent_endpoint.retired_listener_failed',
} as const;

export const agentHooksLogEvents = {
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
} as const;

export const agentNotificationsLogEvents = {
    decided: 'agent_notifications.decided',
    deliveryFallback: 'agent_notifications.delivery_fallback',
    operationFailed: 'agent_notifications.operation_failed',
    settingsRefreshSuppressed: 'agent_notifications.settings_refresh_suppressed',
} as const;
