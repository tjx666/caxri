import type { MobileConnectionStatus } from '../connection/connection-state';

export type DashboardSubscriptionMode = 'active' | 'fallback' | 'pending';

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
    return pathname === home || pathname.startsWith(`${home}/s/`);
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
 * The subscription acknowledgement must precede the snapshot read. A late acknowledgement after unmount is removed from
 * its original connection and cannot turn a hidden dashboard observer back on.
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
            const subscribed = await subscribe((event) => {
                if (isDisposed || isResyncRequired) return;
                onEvent(event);
                if (event.kind !== 'resync-required') return;
                isResyncRequired = true;
                onMode('fallback');
                onResyncRequired();
            });
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
    // eslint-disable-next-line no-void -- The returned cleanup owns the asynchronous subscription lifecycle.
    void attach();
    return () => {
        isDisposed = true;
        // eslint-disable-next-line no-void -- The old connection may already be closed; unsubscribe handles that case.
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
