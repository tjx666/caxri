/**
 * Agent Commander events of the structured-log registry (`logEventCatalog.agentCommander` in `./logging.ts`): the
 * Commander window, its Server lifecycle, completion notices, its task ledger, and the Commander Inbox.
 */
export const agentCommanderLogEvents = {
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
     * One `commander.session.handOver` request finished: `fields.accepted` and `fields.rejected` count its entries,
     * `fields.reasons` names each refusal's closed reason, `fields.conversations` counts imported external
     * conversations, and `fields.ownershipOnly` counts Sessions handed over without a conversation to continue.
     */
    sessionsHandedOver: 'agent_commander.sessions_handed_over',
    /**
     * A handed-over Session left the Commander. `fields.reason` is `take_back` (the user asked) or `human_input` (the
     * user typed into its Agent), with the hand-over's age and whether the Commander had already continued it.
     */
    sessionTakenBack: 'agent_commander.session_taken_back',
    /**
     * Handover conversation discovery could not ask the machine which Codex conversations are still open, so Codex rows
     * fell back to the transcript-mtime heuristic. `fields.reason` is a closed `OpenCodexSessionsProbeFailure` and
     * `durationMs` the probe's duration; never a path or a conversation id.
     */
    codexOpenProbeFailed: 'agent_commander.codex_open_probe_failed',
    /**
     * The Commander's first task continued a handed-over conversation, with the hand-over's age in `fields.waitMs`.
     */
    handoverContinued: 'agent_commander.handover_continued',
    /**
     * `commander.stop` parked the Commander Terminal. `fields.outcome` is `stopped` or `not_running`.
     */
    stopped: 'agent_commander.stopped',
    /**
     * `commander.switchAgent` finished. `fields.outcome` is `switched` (the Commander Terminal moved to `fields.to` on
     * a new conversation), `unchanged` (it already ran that Agent), or `stored` (no Commander Terminal yet; the next
     * start uses it), with `fields.from` and the duration.
     */
    agentSwitched: 'agent_commander.agent_switched',
    /**
     * Preparing a Claude Code Commander launch marked its workspace trusted in Claude Code's config. `fields.outcome`
     * is the closed `ClaudeFolderTrustOutcome`; anything but `granted` or `already_trusted` means the first launch
     * shows Claude Code's trust prompt.
     */
    claudeTrustPrepared: 'agent_commander.claude_trust_prepared',
    /**
     * Clear Commander Data finished. On `fields.outcome: 'cleared'` the fields count what went (`tasksDeleted`,
     * `taskFilesDeleted`, `inboxItemsDeleted`) and flag what was reset (`memoryReset`, `instructionsRewritten`,
     * `conversationReset`). On `failed` (a `warn`) `fields.failedStage` is `stores`, `instructions`, or `conversation`,
     * with the `tasksDeleted` already gone. Both carry `fields.handoversForgotten` (hand-overs the Commander had not
     * continued, dropped with their deleted task), `fields.taskScope` (`all`, `closed`, or `selected`), and the
     * duration; never a task title, file name, or memory text.
     */
    dataCleared: 'agent_commander.data_cleared',
    /**
     * A coalesced batch of delegation completion notices was injected into the Commander Terminal. `fields.count` is
     * the number of delegations the single line reports, so this also measures how often coalescing fires.
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
     * delivery could not be confirmed. Carries a closed `fields.reason` (`CommanderCompletionNoticeDeliveryFailure`)
     * distinguishing the two; a gate that simply is not satisfied yet (a draft, a busy Commander) is not a failure; it
     * is `completionNoticeDeferred` at debug level and resolves itself on the next idle point.
     */
    completionNoticeDeliveryFailed: 'agent_commander.completion_notice_delivery_failed',
    /**
     * A relaunched Commander started with the notices it missed as its first prompt. `fields.count` is the number of
     * delegation notices it carried, `fields.inboxCount` the Inbox events, `fields.interruptedTurn` whether a turn had
     * been cut off, and `fields.waitMs` how long the oldest of them waited.
     */
    resumePromptDelivered: 'agent_commander.resume_prompt_delivered',
    /**
     * A Commander task was recorded. `fields.origin` is `commander` (the Commander registered it) or `delegation` (the
     * ledger recorded a delegation the Commander dispatched without registering one).
     */
    taskRecorded: 'agent_commander.task_recorded',
    /**
     * Recording a task for a delegation the Commander dispatched failed. The delegation itself proceeds; the ledger
     * simply misses that row.
     */
    taskRecordFailed: 'agent_commander.task_record_failed',
    /**
     * A Commander task changed status: `fields.from`, `fields.to`, and the task's `ageMs`.
     */
    taskTransitioned: 'agent_commander.task_transitioned',
    /**
     * The Commander added an Inbox item or replaced the open one with the same key. Fields are the item ID, its closed
     * `kind`, and `outcome` (`added` or `updated`); never its title or body.
     */
    inboxItemReported: 'agent_commander.inbox_item_reported',
    /**
     * An Inbox item closed. `fields.reason` is a closed `CommanderInboxCloseReason`, with the item's `kind`, its
     * `openMs` lifetime, and its reply count, so how long the owner takes to act is measurable per kind.
     */
    inboxItemClosed: 'agent_commander.inbox_item_closed',
    /**
     * The owner replied to an Inbox item. Fields are the item ID, its `kind`, the reply `sequence`, and the reply
     * `source` (`desktop` or `mobile`); never the reply text.
     */
    inboxReplied: 'agent_commander.inbox_replied',
    /**
     * A `merge` item's evidence went stale or became current again. `fields.reason` is the closed
     * `CommanderInboxStaleReason`, or `null` when cleared.
     */
    inboxStaleChanged: 'agent_commander.inbox_stale_changed',
    /**
     * Refreshing one `merge` item's pull request from GitHub failed. `fields.kind` is the shared CLI failure class; the
     * item keeps its last known state rather than being closed.
     */
    inboxPullRequestRefreshFailed: 'agent_commander.inbox_pull_request_refresh_failed',
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
} as const;
