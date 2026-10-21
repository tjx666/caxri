/**
 * Native window events of the structured-log registry (`logEventCatalog.window` in `./logging.ts`): window lifecycle,
 * renderer health, and Session tear-off into additional Workbench windows.
 */
export const windowLogEvents = {
    closeConfirmation: 'window.close_confirmation',
    closeDecision: 'window.close_decision',
    closeFailed: 'window.close_failed',
    closed: 'window.closed',
    created: 'window.created',
    /**
     * A select, resume, or notification click for a Session another window owns was redirected to that window.
     */
    ownerRedirected: 'window.owner_redirected',
    presenceReportFailed: 'window.presence_report_failed',
    readyToShow: 'window.ready_to_show',
    renderProcessCrashLoop: 'window.render_process_crash_loop',
    renderProcessGone: 'window.render_process_gone',
    responsive: 'window.responsive',
    /**
     * Open in New Window opened a new Workbench window, with the time the Server move took.
     */
    tearOffOpened: 'window.tear_off_opened',
    /**
     * An Open in New Window that did not open one, with a closed `reason`: `shown_session` (the source window shows
     * that Session), `open_elsewhere` (another window has it open), or `window_failed`.
     */
    tearOffRejected: 'window.tear_off_rejected',
    /**
     * The user closed a tear-off window, which released its Open Sessions without touching any Terminal.
     */
    tearOffReleased: 'window.tear_off_released',
    /**
     * Releasing a closed tear-off window's Open Sessions failed, with the `attempt` (1 or 2) that failed. After the
     * second failure the Server keeps a strip for a window that no longer exists until the next launch.
     */
    tearOffReleaseFailed: 'window.tear_off_release_failed',
    /**
     * Tear-off windows reopened at launch, with how many.
     */
    tearOffRestored: 'window.tear_off_restored',
    /**
     * Reopening torn-off windows failed (the Server read or the primary window's Renderer never became ready); their
     * strips stay stored and restore on the next launch.
     */
    tearOffRestoreFailed: 'window.tear_off_restore_failed',
    unresponsive: 'window.unresponsive',
} as const;
