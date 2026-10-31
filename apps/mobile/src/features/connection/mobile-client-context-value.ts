import type {
    MobileSubscriptionResource,
    MobileUpdateRecoveryPayload,
} from '@caxri/mobile-transport';
import type { CaxriMethod, MethodResult, ParametersArgument } from '@caxri/protocol';

import type { MobileConnectionStatus } from './connection-state';
import type { MobileGatewayRouteKind } from './gateway-routes';
import type { MobileSubscriptionListener } from './mobile-frame-router';
import type { MobileGatewaySubscriptionHandle } from './mobile-gateway-connection';
import type { MobileRelayFailureKind } from './relay-failure';

export interface MobileClientContextValue {
    cancelPairing: () => void;
    connectionEpoch: number;
    connectionScopeKey: string | null;
    forgetDevice: () => Promise<void>;
    hostId: string | null;
    isForeground: boolean;
    getLastSeenAt: () => number | null;
    /**
     * The path the current connection took, or `null` without one. Plain-HTTP side channels on the gateway (web
     * previews) are reachable only over a `direct` route; see `docs/mobile/relay.md`.
     */
    route: MobileGatewayRouteKind | null;
    pair: (pairingLink: string) => Promise<void>;
    paired: boolean;
    /**
     * Present only while a newer Desktop refuses this app's transport version: proves the stored pairing over the
     * frozen recovery exchange and returns the Android update Desktop ships, with a fresh download URL.
     */
    recoverUpdate: (() => Promise<MobileUpdateRecoveryPayload>) | null;
    request: <M extends CaxriMethod>(
        method: M,
        ...arguments_: ParametersArgument<M>
    ) => Promise<MethodResult<M>>;
    /**
     * Why the Relay refused the last reconnect, while the connection is down; `null` when it is connected or the
     * failure is not a specific Relay refusal.
     */
    relayFailure: MobileRelayFailureKind | null;
    retryConnection: () => void;
    retryCredentialLoad: () => void;
    status: MobileConnectionStatus;
    subscribe: (
        resource: MobileSubscriptionResource,
        listener: MobileSubscriptionListener,
    ) => Promise<MobileGatewaySubscriptionHandle>;
    subscriptionAvailable: boolean;
}
