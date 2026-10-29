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
     * A computer status read that served the phone without one of its parts, with a closed `part` (`processTable` when
     * `ps` failed and only system figures were returned, `terminals` when Server Core's Terminal list failed and
     * Session load was left empty, `memory` when the platform memory reading failed and the coarse total-minus-free
     * figure was served) and the error class.
     */
    hostStatusSampleFailed: 'mobile_gateway.host_status_sample_failed',
    /**
     * One record per Android update download request, with a closed `outcome`, served bytes, and duration.
     */
    updateDownload: 'mobile_gateway.update_download',
    /**
     * One record per update-recovery exchange from a phone whose transport version no longer matches, with a closed
     * `outcome`.
     */
    updateRecovery: 'mobile_gateway.update_recovery',
    /**
     * A phone asked to preview a Session's local web server, with `listener` `started` or `reused`.
     */
    previewOpened: 'mobile_gateway.preview_opened',
    /**
     * One record per preview listener lifetime: its closed `reason` (`idle`, `cleared`, `evicted`), `durationMs`,
     * proxied `requests` and `upgrades`, `upstreamErrors`, and refused requests by closed cause. No URL or content.
     */
    previewClosed: 'mobile_gateway.preview_closed',
    enabled: 'mobile_gateway.enabled',
    disabled: 'mobile_gateway.disabled',
    /**
     * The remembered mobile-access switch: `restored` or `restore-failed` when a Server start reopens the gateway,
     * `write-failed` when the owner's switch could not be saved for the next start.
     */
    accessPersistence: 'mobile_gateway.access_persistence',
    connectionEstablished: 'mobile_gateway.connection_established',
    /**
     * An established connection ended, with its `durationMs` and a closed `cause` (`peer-closed`, `peer-dropped`,
     * `heartbeat-idle`, `server-terminated` with `failureReason`, `revoked`, `gateway-disabled`). A `peer-closed`
     * record adds the numeric `closeCode` and, for a phone's private-range code, the decoded `clientReason`. Both this
     * and `connectionEstablished` carry the `route` (`lan` or `relay`) the phone reached the Server on.
     */
    connectionEnded: 'mobile_gateway.connection_ended',
    /**
     * The Server's outbound Relay registration changed state: `state` (`connecting`, `online`, `offline`, `stopped`)
     * with a closed `cause` (`started`, `registered`, `registration-rejected`, `closed-by-relay` with `relayReason`,
     * `network-error`, `heartbeat-timeout`, `protocol-error`, `disabled`), the reconnect `attempt`, the previous
     * registration's `connectedMs`, and the URL `scheme`. Never the Relay address, host key, grants, or tickets.
     */
    relayState: 'mobile_gateway.relay_state',
    /**
     * A phone reached the Server through the Relay but its dial-back failed, with a closed `reason` (`dial-failed`,
     * `accept-rejected`, `capacity`).
     */
    relayDialFailed: 'mobile_gateway.relay_dial_failed',
    pairingOutcome: 'mobile_gateway.pairing_outcome',
    pairingSummary: 'mobile_gateway.pairing_summary',
} as const;
