/**
 * Caxri Bot events of the structured-log registry (`logEventCatalog.caxriBot` in `./logging.ts`): the Caxri Bot window,
 * its Server lifecycle, completion notices, its task ledger, and the Bot Inbox.
 */
export const caxriBotLogEvents = {
    consoleError: 'caxri_bot.console_error',
    /**
     * `bot.ensure` finished. `fields.outcome` is `created` (a new Caxri Bot Terminal), `restored` (an interrupted,
     * suspended, or stopped one was resumed), or `running` (nothing to do), with its duration.
     */
    ensured: 'caxri_bot.ensured',
    /**
     * Caxri Bot created a Session to delegate into, or removed one a refused delegation never used.
     */
    sessionCreated: 'caxri_bot.session_created',
    sessionDiscarded: 'caxri_bot.session_discarded',
    /**
     * One `bot.session.handOver` request finished: `fields.accepted` and `fields.rejected` count its entries,
     * `fields.reasons` names each refusal's closed reason, `fields.conversations` counts imported external
     * conversations, and `fields.ownershipOnly` counts Sessions handed over without a conversation to continue.
     */
    sessionsHandedOver: 'caxri_bot.sessions_handed_over',
    /**
     * A handed-over Session left Caxri Bot. `fields.reason` is `take_back` (the user asked) or `human_input` (the user
     * typed into its Agent), with the hand-over's age and whether Caxri Bot had already continued it.
     */
    sessionTakenBack: 'caxri_bot.session_taken_back',
    /**
     * Handover conversation discovery could not ask the machine which Codex conversations are still open, so Codex rows
     * fell back to the transcript-mtime heuristic. `fields.reason` is a closed `OpenCodexSessionsProbeFailure` and
     * `durationMs` the probe's duration; never a path or a conversation id.
     */
    codexOpenProbeFailed: 'caxri_bot.codex_open_probe_failed',
    /**
     * Caxri Bot's first task continued a handed-over conversation, with the hand-over's age in `fields.waitMs`.
     */
    handoverContinued: 'caxri_bot.handover_continued',
    /**
     * `bot.stop` parked Caxri Bot Terminal. `fields.outcome` is `stopped` or `not_running`.
     */
    stopped: 'caxri_bot.stopped',
    /**
     * `bot.switchAgent` finished. `fields.outcome` is `switched` (the Caxri Bot Terminal moved to `fields.to` on a new
     * conversation), `unchanged` (it already ran that Agent), or `stored` (no Caxri Bot Terminal yet; the next start
     * uses it), with `fields.from` and the duration.
     */
    agentSwitched: 'caxri_bot.agent_switched',
    /**
     * Preparing a Claude Code launch for Caxri Bot marked its workspace trusted in Claude Code's config.
     * `fields.outcome` is the closed `ClaudeFolderTrustOutcome`; anything but `granted` or `already_trusted` means the
     * first launch shows Claude Code's trust prompt.
     */
    claudeTrustPrepared: 'caxri_bot.claude_trust_prepared',
    /**
     * Clear Caxri Bot Data finished. On `fields.outcome: 'cleared'` the fields count what went (`tasksDeleted`,
     * `taskFilesDeleted`, `inboxItemsDeleted`) and flag what was reset (`memoryReset`, `instructionsRewritten`,
     * `conversationReset`). On `failed` (a `warn`) `fields.failedStage` is `stores`, `instructions`, or `conversation`,
     * with the `tasksDeleted` already gone. Both carry `fields.handoversForgotten` (hand-overs Caxri Bot had not
     * continued, dropped with their deleted task), `fields.taskScope` (`all`, `closed`, or `selected`), and the
     * duration; never a task title, file name, or memory text.
     */
    dataCleared: 'caxri_bot.data_cleared',
    /**
     * A coalesced batch of delegation completion notices was injected into the Caxri Bot Terminal. `fields.count` is
     * the number of delegations the single line reports, so this also measures how often coalescing fires.
     */
    completionNoticeDelivered: 'caxri_bot.completion_notice_delivered',
    /**
     * Pending notices are held back by a delivery gate. `fields.reason` is a closed `BotCompletionNoticeDeferral`,
     * logged once per gate change for the current batch.
     */
    completionNoticeDeferred: 'caxri_bot.completion_notice_deferred',
    /**
     * A delegation transition was queued for the Caxri Bot Terminal, with the batch's size after queueing.
     */
    completionNoticeQueued: 'caxri_bot.completion_notice_queued',
    /**
     * A completion notice batch was consumed (so it will never be retried) but its PTY write was rejected or its
     * delivery could not be confirmed. Carries a closed `fields.reason` (`BotCompletionNoticeDeliveryFailure`)
     * distinguishing the two; a gate that simply is not satisfied yet (a draft, a busy Caxri Bot) is not a failure; it
     * is `completionNoticeDeferred` at debug level and resolves itself on the next idle point.
     */
    completionNoticeDeliveryFailed: 'caxri_bot.completion_notice_delivery_failed',
    /**
     * A relaunched Caxri Bot started with the notices it missed as its first prompt. `fields.count` is the number of
     * delegation notices it carried, `fields.inboxCount` the Inbox events, `fields.interruptedTurn` whether a turn had
     * been cut off, and `fields.waitMs` how long the oldest of them waited.
     */
    resumePromptDelivered: 'caxri_bot.resume_prompt_delivered',
    /**
     * Caxri Bot launched with no prompt and became able to take a notice. `fields.reason` is `session_started` (its
     * Agent reported SessionStart) or `start_timeout` (it reported nothing within the wait, as Codex does until the
     * first prompt goes in), with `waitMs` since the launch.
     */
    freshLaunchReady: 'caxri_bot.fresh_launch_ready',
    /**
     * A Caxri Bot task was recorded. `fields.origin` is `bot` (Caxri Bot registered it) or `delegation` (the ledger
     * recorded a delegation Caxri Bot dispatched without registering one).
     */
    taskRecorded: 'caxri_bot.task_recorded',
    /**
     * Recording a task for a delegation Caxri Bot dispatched failed. The delegation itself proceeds; the ledger simply
     * misses that row.
     */
    taskRecordFailed: 'caxri_bot.task_record_failed',
    /**
     * A Caxri Bot task changed status: `fields.from`, `fields.to`, and the task's `ageMs`.
     */
    taskTransitioned: 'caxri_bot.task_transitioned',
    /**
     * Caxri Bot added an Inbox item or replaced the open one with the same key. Fields are the item ID, its closed
     * `kind`, and `outcome` (`added` or `updated`); never its title or body.
     */
    inboxItemReported: 'caxri_bot.inbox_item_reported',
    /**
     * An Inbox item closed. `fields.reason` is a closed `BotInboxCloseReason`, with the item's `kind`, its `openMs`
     * lifetime, and its reply count, so how long the owner takes to act is measurable per kind.
     */
    inboxItemClosed: 'caxri_bot.inbox_item_closed',
    /**
     * The owner replied to an Inbox item. Fields are the item ID, its `kind`, the reply `sequence`, and the reply
     * `source` (`desktop` or `mobile`); never the reply text.
     */
    inboxReplied: 'caxri_bot.inbox_replied',
    /**
     * A `merge` item's evidence went stale or became current again. `fields.reason` is the closed
     * `BotInboxStaleReason`, or `null` when cleared.
     */
    inboxStaleChanged: 'caxri_bot.inbox_stale_changed',
    /**
     * Refreshing one `merge` item's pull request from GitHub failed. `fields.kind` is the shared CLI failure class; the
     * item keeps its last known state rather than being closed.
     */
    inboxPullRequestRefreshFailed: 'caxri_bot.inbox_pull_request_refresh_failed',
    pageException: 'caxri_bot.page_exception',
    preloadError: 'caxri_bot.preload_error',
    renderProcessCrashLoop: 'caxri_bot.render_process_crash_loop',
    renderProcessGone: 'caxri_bot.render_process_gone',
    requestDenied: 'caxri_bot.request_denied',
    responsive: 'caxri_bot.responsive',
    stopFailed: 'caxri_bot.stop_failed',
    unhandledRejection: 'caxri_bot.unhandled_rejection',
    unresponsive: 'caxri_bot.unresponsive',
    workspaceRepositoryFailed: 'caxri_bot.workspace_repository_failed',
} as const;
