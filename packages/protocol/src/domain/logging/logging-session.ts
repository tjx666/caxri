/**
 * Session events of the structured-log registry (`logEventCatalog.sessionContext` and `logEventCatalog.sessionSearch`
 * in `./logging.ts`).
 */

/**
 * `SessionContextService`'s incremental Agent-transcript scan (issue caxri#1032): the same reader the Workbench Root
 * picker, the status bar's Linear chip, and `SessionPullRequestService` all share.
 */
export const sessionContextLogEvents = {
    /**
     * One scan pass produced nothing. Carries a closed `fields.reason` (`TranscriptScanFailureReason` from
     * `apps/server/src/domains/agents/transcript-security.ts`) so a routine capability miss (`missing`, before an
     * Agent's first line) never looks like a security rejection or an IO failure in the log.
     */
    scanFailed: 'session_context.scan_failed',
    /**
     * The provider rewrote a transcript below the cursor, so the scan restarted from byte zero. A state transition, not
     * a failure: recorded so a shrinking transcript is visible without waiting for the windowed aggregate below.
     */
    cursorReset: 'session_context.cursor_reset',
    /**
     * One aggregate per Session per window: scan count, total/max duration, and approximate bytes scanned, so this
     * every-60-seconds-per-visible-Session path stays answerable without a per-poll record.
     */
    scanWindow: 'session_context.scan_window',
    // `@` Session references: counts and closed reasons only, never conversation text.
    referenceFailed: 'session_context.reference_failed',
    referencePrepared: 'session_context.reference_prepared',
} as const;

/**
 * Session search's persistent transcript index (`docs/session-search.md`). Counts, durations, and closed reasons only:
 * never a query, a title, a path, or message text.
 */
export const sessionSearchLogEvents = {
    /**
     * One incremental index pass: duration, discovered / changed / failed / removed / compressed transcript counts, one
     * `excluded<Reason>` count per closed exclusion reason, and a `scanFailed<Reason>` count for each closed
     * `TranscriptScanFailureReason` a content scan reported (such as `scanFailedDecompressFailed` for a corrupt Codex
     * `.jsonl.zst`). Logged at `warn` when a file failed, a scan stopped early, or a record past the head read's caps
     * (`excludedOversizedRecord`) hid a conversation.
     */
    indexPass: 'session_search.index_pass',
    /**
     * An index pass threw before finishing; the next search starts another.
     */
    indexPassFailed: 'session_search.index_pass_failed',
    /**
     * The index database could not be opened or recreated, so search answers from Caxri Sessions only.
     */
    indexUnavailable: 'session_search.index_unavailable',
    /**
     * The search Worker exited with a closed `fields.reason` (`idle`, `crashed`, `shutdown`, `unavailable`) and its
     * lifetime request count.
     */
    workerExited: 'session_search.worker_exited',
} as const;

export const sessionCompactionLogEvents = {
    checked: 'session.compaction_checked',
    idle: 'session.idle_compaction',
    maintenanceEnded: 'session.compaction_maintenance_ended',
} as const;

/**
 * Airplane Mode (`docs/airplane-mode.md`). One record per phase transition with a closed `reason`, Session and
 * compaction counts, and how long the previous phase lasted: never a title or Session content.
 */
export const sessionAirplaneModeLogEvents = {
    changed: 'session.airplane_mode_changed',
} as const;

export const sessionRenameLogEvents = {
    providerSyncSkipped: 'session_rename.provider_sync_skipped',
    providerTitleMismatch: 'session_rename.provider_title_mismatch',
} as const;

export const sessionPullRequestsLogEvents = {
    cli: 'session_pull_requests.cli',
    cliSummary: 'session_pull_requests.cli_summary',
    focusRefresh: 'session_pull_requests.focus_refresh',
    lookupUnavailable: 'session_pull_requests.lookup_unavailable',
    refresh: 'session_pull_requests.refresh',
    refreshFailed: 'session_pull_requests.refresh_failed',
    autoArchive: 'session_pull_requests.auto_archive',
    startupReconcile: 'session_pull_requests.startup_reconcile',
} as const;
