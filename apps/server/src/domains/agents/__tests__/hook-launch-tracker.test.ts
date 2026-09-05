import { describe, expect, it } from 'vitest';

import { HOOK_TURN_PRESERVE_MS, HookLaunchTracker } from '../hook-launch-tracker';

describe('HookLaunchTracker', () => {
    it('scopes both facts to the launch that reported them', () => {
        const tracker = new HookLaunchTracker(() => 0);

        tracker.markTurnStarted('terminal', 'launch-1');
        expect(tracker.isTurnInFlight('terminal', 'launch-1')).toBe(true);
        expect(tracker.isTurnInFlight('terminal', 'launch-2')).toBe(false);
        expect(tracker.isAuthoritative('terminal', 'launch-1')).toBe(false);

        tracker.markAuthoritative('terminal', 'launch-1');
        expect(tracker.isAuthoritative('terminal', 'launch-1')).toBe(true);
        expect(tracker.isAuthoritative('terminal', undefined)).toBe(false);
        expect(tracker.isTurnInFlight('terminal', 'launch-1')).toBe(false);

        tracker.forget('terminal');
        expect(tracker.isAuthoritative('terminal', 'launch-1')).toBe(false);
    });

    it('expires an in-flight turn whose Stop hook never arrived', () => {
        let now = 1_000;
        const tracker = new HookLaunchTracker(() => now);

        tracker.markTurnStarted('terminal', 'launch-1');
        now += HOOK_TURN_PRESERVE_MS;
        expect(tracker.isTurnInFlight('terminal', 'launch-1')).toBe(true);
        now += 1;
        expect(tracker.isTurnInFlight('terminal', 'launch-1')).toBe(false);

        tracker.markTurnStarted('terminal', 'launch-1');
        expect(tracker.isTurnInFlight('terminal', 'launch-1')).toBe(true);
    });

    it('ends an in-flight turn on a user interrupt without granting authority', () => {
        const tracker = new HookLaunchTracker(() => 0);

        tracker.markTurnStarted('terminal', 'launch-1');
        tracker.markTurnInterrupted('terminal');
        expect(tracker.isTurnInFlight('terminal', 'launch-1')).toBe(false);
        expect(tracker.isAuthoritative('terminal', 'launch-1')).toBe(false);

        tracker.markAuthoritative('terminal', 'launch-1');
        tracker.markTurnInterrupted('terminal');
        expect(tracker.isAuthoritative('terminal', 'launch-1')).toBe(true);
    });
});
