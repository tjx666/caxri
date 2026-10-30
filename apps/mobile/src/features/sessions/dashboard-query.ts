import type { MobileConnectionStatus } from '../connection/connection-state';

/**
 * `sent` means the subscribe frame is on the wire but not yet acknowledged; the first read may already travel behind
 * it.
 */
export type DashboardSubscriptionMode = 'active' | 'fallback' | 'pending' | 'sent';

interface DashboardSubscriptionHandle {
    unsubscribe(): Promise<void>;
}

interface DashboardEvent {
    kind: string;
}

export const dashboardQueryKey = (connectionScopeKey: string) =>
    ['mobile', 'dashboard', connectionScopeKey] as const;

export const isDashboardRouteVisible = (pathname: string, hostId: string): boolean => {
    const home = `/h/${encodeURIComponent(hostId)}`;
    return pathname === home || pathname === `${home}/new` || pathname.startsWith(`${home}/s/`);
};

export const shouldObserveDashboard = ({
    connectionScopeKey,
    isForeground,
    status,
    visible,
}: {
    connectionScopeKey: string | null;
    isForeground: boolean;
    status: MobileConnectionStatus;
    visible: boolean;
}): boolean => connectionScopeKey !== null && status === 'connected' && isForeground && visible;

export const dashboardPollInterval = (
    isObservable: boolean,
    subscriptionMode: DashboardSubscriptionMode,
): number | false => (isObservable && subscriptionMode === 'fallback' ? 2_500 : false);

/**
 * Reports `sent` as soon as the subscribe frame left, so the snapshot read follows it on the same ordered socket
 * instead of waiting a round trip for the acknowledgement; the Server turns a change it saw before acknowledging into a
 * `dashboard.changed` push. A late acknowledgement after unmount is removed from its original connection and cannot
 * turn a hidden dashboard observer back on.
 */
export const startDashboardSubscription = (
    subscribe: (onEvent: (event: DashboardEvent) => void) => Promise<DashboardSubscriptionHandle>,
    onEvent: (event: DashboardEvent) => void,
    onMode: (mode: DashboardSubscriptionMode) => void,
    onResyncRequired: () => void,
): (() => void) => {
    let isDisposed = false;
    let isResyncRequired = false;
    let handle: DashboardSubscriptionHandle | null = null;
    const unsubscribe = async (current: DashboardSubscriptionHandle): Promise<void> => {
        try {
            await current.unsubscribe();
        } catch {
            // The original connection can already be closed during navigation or reconnect.
        }
    };
    const attach = async (): Promise<void> => {
        try {
            const pending = subscribe((event) => {
                if (isDisposed || isResyncRequired) return;
                onEvent(event);
                if (event.kind !== 'resync-required') return;
                isResyncRequired = true;
                onMode('fallback');
                onResyncRequired();
            });
            if (!isDisposed && !isResyncRequired) onMode('sent');
            const subscribed = await pending;
            if (isDisposed) {
                await unsubscribe(subscribed);
                return;
            }
            handle = subscribed;
            if (isResyncRequired) return;
            onMode('active');
        } catch {
            if (!isDisposed) onMode('fallback');
        }
    };
    void attach();
    return () => {
        isDisposed = true;
        if (handle) void unsubscribe(handle);
    };
};

/**
 * Events only invalidate the dashboard. If one arrives during a snapshot, request another after the current query
 * settles so the event cannot be swallowed by the in-flight result.
 */
export const readDashboardSnapshot = async <Result>(
    read: () => Promise<Result>,
    eventVersion: () => number,
    onConcurrentEvent: () => void,
): Promise<Result> => {
    const before = eventVersion();
    const result = await read();
    if (eventVersion() !== before) onConcurrentEvent();
    return result;
};
