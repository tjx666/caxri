import { describe, expect, it } from 'vitest';

import { canAdoptTerminalLease } from '../lease-admission';

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
