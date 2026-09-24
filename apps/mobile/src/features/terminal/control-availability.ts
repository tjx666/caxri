import type { MobileDeviceRole } from '@caxri/protocol';

export type LiveTerminalState = 'loading' | 'ready' | 'stale' | 'stopped' | 'unavailable' | 'error';

export const shouldObserveTerminal = ({
    isStopped,
    subscriptionAvailable,
    visible,
    webviewReady,
}: {
    isStopped: boolean;
    subscriptionAvailable: boolean;
    visible: boolean;
    webviewReady: boolean;
}): boolean => visible && webviewReady && subscriptionAvailable && !isStopped;

export const terminalViewState = (
    state: LiveTerminalState,
    isStopped: boolean,
    isConnected: boolean,
    isSubscriptionAvailable: boolean,
): LiveTerminalState => {
    if (isStopped) return 'stopped';
    if (state === 'ready' && (!isConnected || !isSubscriptionAvailable)) return 'stale';
    return state;
};

export const canUseTerminalControls = ({
    connected,
    generation,
    hasSubscription,
    role,
    state,
}: {
    connected: boolean;
    generation: number | null;
    hasSubscription: boolean;
    role: MobileDeviceRole | null;
    state: LiveTerminalState;
}): boolean =>
    role === 'control' && connected && state === 'ready' && generation !== null && hasSubscription;
