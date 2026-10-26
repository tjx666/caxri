/**
 * Mobile gateway events of the structured-log registry (`logEventCatalog.mobileGateway` in `./logging.ts`): pairing,
 * connections, Session reads, Terminal resyncs, and update delivery to phones, with closed outcomes and no payloads.
 */
export const mobileGatewayLogEvents = {
    sessionReadSummary: 'mobile_gateway.session_read_summary',
    failure: 'mobile_gateway.failure',
    failureSummary: 'mobile_gateway.failure_summary',
    terminalResyncSummary: 'mobile_gateway.terminal_resync_summary',
    /**
     * A Host observer or lease release that failed when a phone's Terminal subscription closed or its observe failed,
     * with a closed `reason`; the Host may still hold an observer for that subscription.
     */
    terminalTeardownFailed: 'mobile_gateway.terminal_teardown_failed',
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
} as const;
