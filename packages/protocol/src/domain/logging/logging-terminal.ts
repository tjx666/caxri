/**
 * Terminal events of the structured-log registry (`logEventCatalog.pty`, `terminal`, and `terminalHost` in
 * `../logging.ts`).
 */
export const ptyLogEvents = {
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
} as const;

export const terminalLogEvents = {
    humanSteer: 'terminal.human_steer',
    resourceAlertCleared: 'terminal.resource_alert_cleared',
    resourceAlertRaised: 'terminal.resource_alert_raised',
    resourceSampleFailed: 'terminal.resource_sample_failed',
    restoreCwdRejected: 'terminal.restore_cwd_rejected',
    restoreInterruptedFailed: 'terminal.restore_interrupted_failed',
    resumeSkipped: 'terminal.resume_skipped',
    /**
     * An Agent launch that resumed a parked Terminal: the closed park `reason` (`idle`, `observation`, `untouched`,
     * `archived`, `detached`, `requested`), the provider, and `suspendedForMs`. An Agent an earlier Server Core left
     * `suspended` or `detached` logs `reason: 'beforeRestart'` with `suspendedForMs: null`, since its park time was in
     * memory.
     */
    resumed: 'terminal.resumed',
    suspendFailed: 'terminal.suspend_failed',
    /**
     * One parked PTY: the closed `reason` (`idle`, `observation`, `untouched`, `archived`, `detached`, `requested`,
     * `terminated`) and the provider; the automatic `idle`/`observation`/`untouched` reasons also carry `idleMs` (time
     * since the Agent's last activity) and `backgroundMs` (time since its Session was left).
     */
    suspended: 'terminal.suspended',
    /**
     * One `terminal.switchSurface` request: the closed `outcome` (`switched`, `startedNew` for an Agent with no
     * conversation to carry over, `turnRunning`, `failed`), both surfaces, the provider, whether a running turn was
     * interrupted, and the duration.
     */
    surfaceSwitched: 'terminal.surface_switched',
} as const;

export const terminalHostLogEvents = {
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
} as const;
