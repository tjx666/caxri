import type { TerminalControlTarget } from './control-input';

/**
 * An asynchronous takeover may become stale while the request is in flight.
 */
export const canAdoptTerminalLease = ({
    admittedEpoch,
    currentEpoch,
    currentGeneration,
    currentSubscriptionId,
    isConnected,
    visible,
    target,
}: {
    admittedEpoch: number;
    currentEpoch: number;
    currentGeneration: number | null;
    currentSubscriptionId: string | null;
    isConnected: boolean;
    visible: boolean;
    target: TerminalControlTarget;
}): boolean =>
    admittedEpoch === currentEpoch &&
    currentGeneration === target.expectedGeneration &&
    currentSubscriptionId === target.subscriptionId &&
    isConnected &&
    visible;
