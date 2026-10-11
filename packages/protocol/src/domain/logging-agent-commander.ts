/**
 * Agent Commander events of the structured-log registry (`logEventCatalog.agentCommander` in `./logging.ts`): the
 * Commander window, its Server lifecycle, completion notices, and its task ledger.
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
     * `commander.stop` parked the Commander Terminal. `fields.outcome` is `stopped` or `not_running`.
     */
    stopped: 'agent_commander.stopped',
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
     * delegation notices it carried, `fields.interruptedTurn` whether a turn had been cut off, and `fields.waitMs` how
     * long the oldest of them waited.
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
