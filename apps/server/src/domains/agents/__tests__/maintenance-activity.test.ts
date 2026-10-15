import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentLifecycleSignal } from '../hooks/contract';
import { MaintenanceActivity } from '../maintenance-activity';

const launch = {
    terminalId: 'example-terminal',
    launchId: 'example-launch',
    provider: 'codex' as const,
};
const signal = (
    phase: AgentLifecycleSignal['phase'],
    extra: Partial<AgentLifecycleSignal> = {},
): AgentLifecycleSignal => ({ ...launch, phase, agentTurnId: 'compact-turn', ...extra });
const tracker = new MaintenanceActivity(50);

afterEach(() => {
    tracker.clear();
    vi.useRealTimers();
});

describe('maintenance turn classification', () => {
    it('retains a Core-marked Chat turn through an unmarked provider-exit failure', () => {
        tracker.classify(signal('turnStarted', { activity: 'maintenance' }));
        expect(tracker.classify(signal('turnFailed')).activity).toBe('maintenance');
        expect(
            tracker.classify(signal('turnStarted', { agentTurnId: 'next-user-turn' })).activity,
        ).toBeUndefined();
    });

    it('binds a main turn and preserves its classification through failure', () => {
        const lease = tracker.arm(launch);
        expect(tracker.classify(signal('turnStarted')).activity).toBe('maintenance');
        lease.cancel();
        expect(tracker.classify(signal('turnFailed')).activity).toBe('maintenance');
        expect(
            tracker.classify(signal('turnStarted', { agentTurnId: 'user-turn' })).activity,
        ).toBeUndefined();
    });

    it('does not consume intent on a subagent or another launch', () => {
        tracker.arm(launch);
        expect(
            tracker.classify(signal('turnStarted', { agentId: 'child' })).activity,
        ).toBeUndefined();
        expect(
            tracker.classify(signal('turnStarted', { launchId: 'old-launch' })).activity,
        ).toBeUndefined();
        expect(tracker.classify(signal('turnStarted')).activity).toBe('maintenance');
        expect(
            tracker.classify(signal('turnFinished', { agentTurnId: 'other-turn' })).activity,
        ).toBeUndefined();
        expect(tracker.classify(signal('turnFinished', { agentTurnId: undefined })).activity).toBe(
            'maintenance',
        );
    });

    it('keeps a replacement intent when an earlier delivery is rejected late', () => {
        const earlier = tracker.arm(launch);
        tracker.arm(launch);
        earlier.cancel();
        expect(tracker.classify(signal('turnStarted')).activity).toBe('maintenance');
    });

    it('expires unobserved intent and forgets retired launches', () => {
        vi.useFakeTimers();
        tracker.arm(launch);
        vi.advanceTimersByTime(51);
        expect(tracker.classify(signal('turnStarted')).activity).toBeUndefined();
        tracker.arm(launch);
        tracker.forget(launch.terminalId);
        expect(tracker.classify(signal('turnStarted')).activity).toBeUndefined();
    });

    it('cannot hide the next user task when maintenance completion was lost', () => {
        tracker.arm(launch);
        tracker.classify(signal('turnStarted'));
        expect(
            tracker.classify(signal('turnStarted', { agentTurnId: 'user-turn' })).activity,
        ).toBeUndefined();
        expect(
            tracker.classify(signal('turnFinished', { agentTurnId: 'user-turn' })).activity,
        ).toBeUndefined();
    });
});
