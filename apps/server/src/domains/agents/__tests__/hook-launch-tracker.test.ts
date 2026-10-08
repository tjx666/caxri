import { describe, expect, it, vi } from 'vitest';

import {
    HOOK_TURN_PRESERVE_MS,
    HookLaunchTracker,
    UNKNOWN_RECOVERY_MS,
    UNKNOWN_RECOVERY_PROBES,
} from '../hook-launch-tracker';

describe('HookLaunchTracker', () => {
    it('records hard expiry when a probe wins the race against its timer', () => {
        let now = 0;
        const released = vi.fn();
        const tracker = new HookLaunchTracker(() => now, undefined, released);
        tracker.markTurnStarted('terminal', 'launch');
        now = HOOK_TURN_PRESERVE_MS + 1;
        expect(tracker.ownsProbe('terminal', 'launch', 'unknown')).toBe(false);
        expect(released).toHaveBeenCalledExactlyOnceWith('terminal', 'launch', {
            reason: 'hardTimeout',
            unknownCount: 1,
            durationMs: now,
        });
        tracker.clear();
    });
    it('actively obtains three unknown observations before releasing a quiet turn', async () => {
        vi.useFakeTimers();
        const expired = vi.fn();
        const tracker = new HookLaunchTracker(
            () => Date.now(),
            (terminalId, launchId) => tracker.observeUnknown(terminalId, launchId),
            expired,
        );
        try {
            tracker.markTurnStarted('terminal', 'launch');
            tracker.observeUnknown('terminal', 'launch');
            await vi.advanceTimersByTimeAsync(119_999);
            expect(expired).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(2);
            expect(expired).toHaveBeenCalledExactlyOnceWith('terminal', 'launch', {
                reason: 'unknownEvidence',
                unknownCount: 3,
                durationMs: 120_000,
            });
            expect(tracker.isTurnInFlight('terminal', 'launch')).toBe(false);
        } finally {
            tracker.clear();
            vi.useRealTimers();
        }
    });

    /**
     * `e2e/hook-turn-recovery.e2e.ts` used to spend two real minutes proving this window on the single-worker CI pool.
     * It now injects a shortened window, so the production constant and the probe schedule derived from it are pinned
     * here: the test above proves the default expiry, and this one proves an override moves both the probes and the
     * deadline together rather than only the deadline.
     */
    it('keeps the production recovery window at two minutes and scales its probes with an override', async () => {
        expect(UNKNOWN_RECOVERY_MS).toBe(2 * 60_000);
        expect(UNKNOWN_RECOVERY_PROBES).toBe(3);
        vi.useFakeTimers();
        const expired = vi.fn();
        const tracker = new HookLaunchTracker(
            () => Date.now(),
            (terminalId, launchId) => tracker.observeUnknown(terminalId, launchId),
            expired,
            undefined,
            4_000,
        );
        try {
            tracker.markTurnStarted('terminal', 'launch');
            tracker.observeUnknown('terminal', 'launch');
            await vi.advanceTimersByTimeAsync(3_999);
            expect(expired).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(2);
            expect(expired).toHaveBeenCalledExactlyOnceWith('terminal', 'launch', {
                reason: 'unknownEvidence',
                unknownCount: 3,
                durationMs: 4_000,
            });
        } finally {
            tracker.clear();
            vi.useRealTimers();
        }
    });

    it('resets missing evidence on activity and cancels timers at every ownership boundary', async () => {
        vi.useFakeTimers();
        const expired = vi.fn();
        const tracker = new HookLaunchTracker(() => Date.now(), undefined, expired);
        try {
            tracker.markTurnStarted('terminal', 'launch');
            tracker.observeUnknown('terminal', 'launch');
            tracker.observeUnknown('terminal', 'launch');
            tracker.observeUnknown('terminal', 'launch');
            await vi.advanceTimersByTimeAsync(119_999);
            tracker.observeEvidence('terminal', 'launch');
            await vi.advanceTimersByTimeAsync(120_001);
            expect(expired).not.toHaveBeenCalled();
            expect(tracker.isTurnInFlight('terminal', 'launch')).toBe(true);
            tracker.markTurnStarted('terminal', 'new-launch');
            tracker.observeUnknown('terminal', 'launch');
            tracker.markTurnInterrupted('terminal');
            await vi.advanceTimersByTimeAsync(HOOK_TURN_PRESERVE_MS + 1);
            expect(expired).not.toHaveBeenCalled();
            tracker.markTurnStarted('terminal', 'final-launch');
            tracker.observeEvidence('terminal', 'final-launch');
            await vi.advanceTimersByTimeAsync(HOOK_TURN_PRESERVE_MS + 1);
            expect(expired).toHaveBeenCalledExactlyOnceWith('terminal', 'final-launch', {
                reason: 'hardTimeout',
                unknownCount: 0,
                durationMs: HOOK_TURN_PRESERVE_MS + 1,
            });
        } finally {
            tracker.clear();
            vi.useRealTimers();
        }
    });

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

    it('lets ordered Codex turn history recover a start hook lost after a hooked completion', () => {
        const tracker = new HookLaunchTracker(() => 0);

        tracker.markAuthoritative('terminal', 'launch-1', 'turn-1');
        expect(tracker.ownsProbe('terminal', 'launch-1', 'running')).toBe(true);
        expect(tracker.ownsProbe('terminal', 'launch-1', 'running', 'turn-1')).toBe(true);
        expect(tracker.ownsProbe('terminal', 'launch-1', 'running', 'turn-2')).toBe(false);
        expect(tracker.isAuthoritative('terminal', 'launch-1')).toBe(false);
    });

    it('does not release attention authority for a different persisted running turn', () => {
        const tracker = new HookLaunchTracker(() => 0);

        tracker.markAuthoritative('terminal', 'launch-1');
        expect(tracker.ownsProbe('terminal', 'launch-1', 'running', 'turn-2')).toBe(true);
        expect(tracker.isAuthoritative('terminal', 'launch-1')).toBe(true);
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
