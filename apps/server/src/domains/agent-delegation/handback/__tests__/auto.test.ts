import { AUTO_HAND_BACK_AFTER_MS } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { DelegationAutoHandBack } from '../auto';
import type { AutoHandBackOutcome } from '../service';

/**
 * A presence that tests move by hand, an owner-side hand-back that records its calls, and a clock.
 */
function harness(options: { humanControlled?: string[]; outcome?: AutoHandBackOutcome } = {}) {
    const state = {
        clock: 1_000,
        enabled: true,
        settled: true,
        visible: new Set<string>(),
        remote: new Set<string>(),
        outcome: options.outcome ?? 'granted',
        calls: [] as string[],
    };
    const human = new Set(options.humanControlled ?? ['child']);
    let notify: (() => void) | undefined;
    const auto = new DelegationAutoHandBack({
        autoHandBack: (sessionId) => {
            state.calls.push(sessionId);
            return state.outcome;
        },
        isEnabled: () => state.enabled,
        isHumanControlled: (sessionId) => human.has(sessionId),
        isObservedRemotely: (sessionId) => state.remote.has(sessionId),
        now: () => state.clock,
        presence: {
            isSettled: () => state.settled,
            onVisibleChange: (listener) => {
                notify = listener;
                return () => (notify = undefined);
            },
            visibleSessionIds: () => state.visible,
        },
        watchHub: {
            registerPoller: () => ({
                label: 'test',
                mode: 'polling',
                startFallback: () => {},
                dispose: async () => {},
            }),
        },
    });
    auto.start();
    const show = (...sessionIds: string[]) => {
        state.visible = new Set(sessionIds);
        expect(notify).toBeDefined();
        notify!();
    };
    const advance = (ms: number) => {
        state.clock += ms;
        auto.sweep();
    };
    return { auto, state, show, advance };
}

describe('automatic hand-back timer', () => {
    it('hands a taken-over Session back once the user has left it alone for the whole wait', () => {
        const h = harness();
        h.show('child');
        h.show('other');
        h.advance(AUTO_HAND_BACK_AFTER_MS - 1);
        expect(h.state.calls).toEqual([]);
        h.advance(1);
        expect(h.state.calls).toEqual(['child']);
        h.advance(AUTO_HAND_BACK_AFTER_MS);
        expect(h.state.calls).toEqual(['child']);
    });

    it('cancels the wait when the user comes back, and restarts it when they leave again', () => {
        const h = harness();
        h.show('child');
        h.show('other');
        h.advance(AUTO_HAND_BACK_AFTER_MS - 1);
        h.show('child');
        h.advance(AUTO_HAND_BACK_AFTER_MS);
        expect(h.state.calls).toEqual([]);
        h.show('other');
        h.advance(AUTO_HAND_BACK_AFTER_MS);
        expect(h.state.calls).toEqual(['child']);
    });

    it('never starts a wait for a Session the user does not hold, or one never seen this lifetime', () => {
        const h = harness({ humanControlled: ['child', 'old'] });
        h.show('delegated');
        h.show('other');
        h.advance(AUTO_HAND_BACK_AFTER_MS);
        expect(h.state.calls).toEqual([]);
        expect(h.auto.waitingSessionIds()).toEqual([]);
    });

    it('restarts the wait while the child is busy, and drops it on a refusal that will not clear', () => {
        const h = harness({ outcome: 'child_busy' });
        h.show('child');
        h.show('other');
        h.advance(AUTO_HAND_BACK_AFTER_MS);
        expect(h.state.calls).toEqual(['child']);
        h.state.outcome = 'parent_gone';
        h.advance(AUTO_HAND_BACK_AFTER_MS - 1);
        expect(h.state.calls).toEqual(['child']);
        h.advance(1);
        expect(h.state.calls).toEqual(['child', 'child']);
        expect(h.auto.waitingSessionIds()).toEqual([]);
    });

    it('treats a phone watching the Session as the user looking at it', () => {
        const h = harness();
        h.show('child');
        h.show('other');
        h.state.remote.add('child');
        h.advance(AUTO_HAND_BACK_AFTER_MS);
        h.state.remote.delete('child');
        h.advance(AUTO_HAND_BACK_AFTER_MS - 1);
        expect(h.state.calls).toEqual([]);
        h.advance(1);
        expect(h.state.calls).toEqual(['child']);
    });

    it('does nothing while turned off or before Desktop reports presence', () => {
        const h = harness();
        h.show('child');
        h.show('other');
        h.state.settled = false;
        h.advance(AUTO_HAND_BACK_AFTER_MS);
        expect(h.state.calls).toEqual([]);
        h.state.enabled = false;
        h.state.settled = true;
        h.advance(AUTO_HAND_BACK_AFTER_MS);
        expect(h.state.calls).toEqual([]);
        expect(h.auto.waitingSessionIds()).toEqual([]);
    });
});
