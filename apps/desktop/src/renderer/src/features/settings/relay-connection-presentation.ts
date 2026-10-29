import type { MobileAccessStatus } from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';

type RelayStatus = NonNullable<MobileAccessStatus['relay']>;

export interface RelayConnectionPresentation {
    /**
     * Visual treatment: a green dot, a spinner, or a red dot.
     */
    kind: 'connected' | 'connecting' | 'failed';
    labelKey: TranslationKey;
    /**
     * Why the last attempt failed, in plain words; only present for `failed`.
     */
    reasonKey?: TranslationKey;
}

const FAILURE_REASON_KEYS = {
    'closed-by-relay': 'settings.mobile.relayStatus.reason.closedByRelay',
    'heartbeat-timeout': 'settings.mobile.relayStatus.reason.heartbeatTimeout',
    'network-error': 'settings.mobile.relayStatus.reason.networkError',
    'protocol-error': 'settings.mobile.relayStatus.reason.protocolError',
    'registration-rejected': 'settings.mobile.relayStatus.reason.registrationRejected',
} as const satisfies Record<NonNullable<RelayStatus['lastFailure']>, TranslationKey>;

/**
 * Maps the Server's Relay registration to the words under the Relay server row. A recorded failure wins over
 * `connecting`: between retries the Server flips between `offline` and `connecting`, and showing the failure through
 * both keeps the row from flickering between a spinner and an error. Absent `relay` means no Relay is configured or
 * Mobile access is off, so no status row.
 */
export function presentRelayConnection(
    relay: MobileAccessStatus['relay'],
): RelayConnectionPresentation | undefined {
    if (!relay) return;
    if (relay.state === 'online')
        return { kind: 'connected', labelKey: 'settings.mobile.relayStatus.connected' };
    if (relay.lastFailure)
        return {
            kind: 'failed',
            labelKey: 'settings.mobile.relayStatus.failed',
            reasonKey: FAILURE_REASON_KEYS[relay.lastFailure],
        };
    return { kind: 'connecting', labelKey: 'settings.mobile.relayStatus.connecting' };
}
