import type { MobileConnectionStatus } from './connection-state';

export interface MobileNetworkHint {
    isConnected?: boolean;
    type?: string;
}

export type MobileNetworkWakeAction = 'defer' | 'ignore' | 'probe' | 'reconnect';

export interface MobileNetworkWakeContext {
    hasOutstandingMutation: boolean;
    isForeground: boolean;
    status: MobileConnectionStatus;
}

export const mobileNetworkWakeAction = ({
    hasOutstandingMutation,
    isForeground,
    network,
    status,
}: MobileNetworkWakeContext & { network: MobileNetworkHint }): MobileNetworkWakeAction => {
    if (!isForeground || network.isConnected !== true) return 'ignore';
    if (status === 'stale') return 'reconnect';
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
    const subscription = subscribe((network) => {
        if (!isActive) return;
        const action = mobileNetworkWakeAction({ ...context(), network });
        if (action !== 'ignore') onAction(action);
    });
    return () => {
        isActive = false;
        subscription.remove();
    };
};
