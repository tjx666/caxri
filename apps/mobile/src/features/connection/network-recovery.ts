import type { MobileConnectionStatus } from './connection-state';

export interface MobileNetworkHint {
    isConnected?: boolean;
    type?: string;
}

export type MobileNetworkWakeAction = 'defer' | 'ignore' | 'probe' | 'reconnect';

export interface MobileNetworkWakeContext {
    hasOutstandingMutation: boolean;
    isForeground: boolean;
    /**
     * A reconnect attempt is already dialing. Its own route race, timeout, and retry recover it, so a repeated hint for
     * the same network must not abandon it for a fresh attempt.
     */
    isReconnecting?: boolean;
    status: MobileConnectionStatus;
}

/**
 * Android re-reports an unchanged network on resume and whenever a VPN or proxy app touches the interface. Restarting a
 * reconnect for such a hint closed the attempt that was about to finish (seen as paired `superseded` closes in the
 * Server's `mobile_gateway.connection_ended` log) and could cost a whole Relay handshake. Only a network type change
 * while dialing still restarts the attempt, since its socket may be bound to the network that just went away. The first
 * hint a watcher sees has nothing to compare with and counts as unchanged; a backoff wait is not dialing, so a hint
 * during it still reconnects at once.
 */
export const mobileNetworkWakeAction = ({
    hasOutstandingMutation,
    isForeground,
    isReconnecting = false,
    network,
    previousType,
    status,
}: MobileNetworkWakeContext & {
    network: MobileNetworkHint;
    /**
     * The type of the previous hint this watcher received, `undefined` before the first one.
     */
    previousType?: string;
}): MobileNetworkWakeAction => {
    if (!isForeground || network.isConnected !== true) return 'ignore';
    if (status === 'stale')
        return isReconnecting && (previousType === undefined || previousType === network.type)
            ? 'ignore'
            : 'reconnect';
    if (status !== 'connected') return 'ignore';
    return hasOutstandingMutation ? 'defer' : 'probe';
};

export const watchMobileNetwork = ({
    context,
    onAction,
    subscribe,
}: {
    context: () => MobileNetworkWakeContext;
    onAction: (action: Exclude<MobileNetworkWakeAction, 'ignore'>) => void;
    subscribe: (listener: (network: MobileNetworkHint) => void) => { remove(): void };
}): (() => void) => {
    let isActive = true;
    let previousType: string | undefined;
    const subscription = subscribe((network) => {
        if (!isActive) return;
        const action = mobileNetworkWakeAction({ ...context(), network, previousType });
        previousType = network.type;
        if (action !== 'ignore') onAction(action);
    });
    return () => {
        isActive = false;
        subscription.remove();
    };
};
