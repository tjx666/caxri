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

/**
 * A control device takes the size lease on its own as soon as the Terminal can be controlled. A phone is used away from
 * the computer, and the Desktop grid it would otherwise mirror is either wider than the screen or too small to read,
 * because the stream is laid out for the Desktop's columns and cannot be reflowed locally. Each subscription gets one
 * automatic attempt so a refused takeover does not loop, and a deliberate release holds until the reader leaves the
 * Terminal.
 */
export const shouldAutoTakeOverTerminal = ({
    attemptedSubscriptionId,
    canTakeOver,
    hasLease,
    isReleasedByUser,
    subscriptionId,
}: {
    attemptedSubscriptionId: string | null;
    canTakeOver: boolean;
    hasLease: boolean;
    isReleasedByUser: boolean;
    subscriptionId: string | null;
}): boolean =>
    canTakeOver &&
    !hasLease &&
    !isReleasedByUser &&
    subscriptionId !== null &&
    subscriptionId !== attemptedSubscriptionId;
