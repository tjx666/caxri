import { describe, expect, it } from 'vitest';

import { canAdoptTerminalLease, shouldAutoTakeOverTerminal } from '../lease-admission';

const target = {
    terminalId: 'terminal-1',
    subscriptionId: 'subscription-1',
    expectedGeneration: 3,
};

describe('mobile Terminal lease admission', () => {
    it('does not revive a takeover completed after leaving, disconnecting, or resubscribing', () => {
        const current = {
            admittedEpoch: 4,
            currentEpoch: 4,
            currentGeneration: 3,
            currentSubscriptionId: 'subscription-1',
            isConnected: true,
            visible: true,
            target,
        };
        expect(canAdoptTerminalLease(current)).toBe(true);
        expect(canAdoptTerminalLease({ ...current, currentEpoch: 5 })).toBe(false);
        expect(canAdoptTerminalLease({ ...current, isConnected: false })).toBe(false);
        expect(canAdoptTerminalLease({ ...current, visible: false })).toBe(false);
        expect(canAdoptTerminalLease({ ...current, currentSubscriptionId: 'subscription-2' })).toBe(
            false,
        );
        expect(canAdoptTerminalLease({ ...current, currentGeneration: 4 })).toBe(false);
    });
});

describe('mobile Terminal automatic takeover', () => {
    const ready = {
        attemptedSubscriptionId: null,
        canTakeOver: true,
        hasLease: false,
        isReleasedByUser: false,
        subscriptionId: 'subscription-1',
    };

    it('takes over once the Terminal can be controlled', () => {
        expect(shouldAutoTakeOverTerminal(ready)).toBe(true);
        expect(shouldAutoTakeOverTerminal({ ...ready, canTakeOver: false })).toBe(false);
        expect(shouldAutoTakeOverTerminal({ ...ready, subscriptionId: null })).toBe(false);
        expect(shouldAutoTakeOverTerminal({ ...ready, hasLease: true })).toBe(false);
    });

    it('tries each subscription once and retries after a resubscribe', () => {
        const attempted = { ...ready, attemptedSubscriptionId: 'subscription-1' };
        expect(shouldAutoTakeOverTerminal(attempted)).toBe(false);
        expect(shouldAutoTakeOverTerminal({ ...attempted, subscriptionId: 'subscription-2' })).toBe(
            true,
        );
    });

    it('respects a deliberate release', () => {
        expect(shouldAutoTakeOverTerminal({ ...ready, isReleasedByUser: true })).toBe(false);
    });
});
