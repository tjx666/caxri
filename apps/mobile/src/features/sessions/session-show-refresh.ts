import type { DashboardSubscriptionMode } from './dashboard-query';
import { dashboardPollInterval } from './dashboard-query';

export const sessionShowRefresh = ({
    isObservable,
    subscriptionAvailable,
    subscriptionIdentity,
    subscriptionState,
}: {
    isObservable: boolean;
    subscriptionAvailable: boolean;
    subscriptionIdentity: string;
    subscriptionState: { identity: string; mode: DashboardSubscriptionMode };
}): { enabled: boolean; pollInterval: number | false } => {
    const mode: DashboardSubscriptionMode = !isObservable
        ? 'pending'
        : !subscriptionAvailable
          ? 'fallback'
          : subscriptionState.identity === subscriptionIdentity
            ? subscriptionState.mode
            : 'pending';
    return {
        enabled: isObservable && mode !== 'pending',
        pollInterval: dashboardPollInterval(isObservable, mode),
    };
};
