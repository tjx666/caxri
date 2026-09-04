import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentLifecycleSignal } from '../hooks/contract';
import { AgentWorkTracker } from '../work-tracker';

const baseSignal = {
    launchId: 'launch-1',
    provider: 'claude',
    terminalId: 'terminal-1',
} as const;

function signal(phase: AgentLifecycleSignal['phase'], agentId?: string): AgentLifecycleSignal {
    return { ...baseSignal, phase, ...(agentId && { agentId }) };
}

describe('AgentWorkTracker', () => {
    afterEach(() => vi.useRealTimers());

    it('drops a deferred completion when a new parent turn starts', () => {
        const onDeferredParentFinished = vi.fn();
        const tracker = new AgentWorkTracker(onDeferredParentFinished);

        tracker.observe(signal('subagentStarted', 'subagent-1'));
        expect(tracker.observe(signal('turnFinished')).deferCompletion).toBe(true);

        tracker.observe(signal('turnStarted'));
        /**
         * The scope was tracked and closed cleanly; only the parent completion it might have released is gone. That is
         * `subagentPending`, not the lost-hook anomaly `subagentUnmatched`.
         */
        expect(tracker.observe(signal('turnFinished', 'subagent-1'))).toEqual({
            deferCompletion: false,
            outcome: 'subagentPending',
        });
        expect(onDeferredParentFinished).not.toHaveBeenCalled();
    });

    it('does not treat a child-scoped turn start as a new parent turn', () => {
        const onDeferredParentFinished = vi.fn();
        const tracker = new AgentWorkTracker(onDeferredParentFinished);

        tracker.observe(signal('subagentStarted', 'subagent-1'));
        tracker.observe(signal('turnFinished'));
        expect(tracker.observe(signal('turnStarted', 'subagent-1'))).toEqual({
            deferCompletion: false,
            outcome: 'accepted',
        });
        tracker.observe(signal('turnFinished', 'subagent-1'));

        expect(onDeferredParentFinished).toHaveBeenCalledOnce();
    });

    /**
     * A multi-subagent turn is the common case, and every intermediate completion in it lands on the same "nothing
     * changed" branch as a genuinely lost hook. They must not share one diagnostic reason: the launch aggregate counts
     * these, and folding them together reports a healthy session as a stream of dropped signals.
     */
    it('separates an intermediate subagent completion from a scope that was never tracked', () => {
        const tracker = new AgentWorkTracker(vi.fn());

        expect(tracker.observe(signal('subagentStarted', 'subagent-1'))).toEqual({
            deferCompletion: false,
            outcome: 'accepted',
        });
        tracker.observe(signal('subagentStarted', 'subagent-2'));
        expect(tracker.observe(signal('turnFinished')).deferCompletion).toBe(true);

        expect(tracker.observe(signal('turnFinished', 'subagent-2'))).toEqual({
            deferCompletion: false,
            outcome: 'subagentPending',
        });
        expect(tracker.observe(signal('turnFinished', 'subagent-unknown'))).toEqual({
            deferCompletion: false,
            outcome: 'subagentUnmatched',
        });
        expect(tracker.observe(signal('subagentStarted'))).toEqual({
            deferCompletion: false,
            outcome: 'subagentUnmatched',
        });
        expect(tracker.observe(signal('subagentStarted', 'subagent-1'))).toEqual({
            deferCompletion: false,
            outcome: 'subagentPending',
        });

        expect(tracker.observe(signal('turnFinished', 'subagent-1'))).toEqual({
            deferCompletion: false,
            outcome: 'accepted',
        });
    });

    it('forgets deferred work when the Terminal launch ends', () => {
        const onDeferredParentFinished = vi.fn();
        const tracker = new AgentWorkTracker(onDeferredParentFinished);

        tracker.observe(signal('subagentStarted', 'subagent-1'));
        tracker.observe(signal('turnFinished'));
        tracker.forget(baseSignal.terminalId);
        tracker.observe(signal('turnFinished', 'subagent-1'));

        expect(onDeferredParentFinished).not.toHaveBeenCalled();
    });

    it('recovers a deferred parent completion after a subagent stays silent', () => {
        vi.useFakeTimers();
        const onDeferredParentFinished = vi.fn();
        const tracker = new AgentWorkTracker(onDeferredParentFinished, {
            staleTimeoutMs: 1_000,
        });

        tracker.observe(signal('subagentStarted', 'subagent-1'));
        expect(tracker.observe(signal('turnFinished')).deferCompletion).toBe(true);

        vi.advanceTimersByTime(999);
        expect(onDeferredParentFinished).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);

        expect(onDeferredParentFinished).toHaveBeenCalledOnce();
        expect(onDeferredParentFinished).toHaveBeenCalledWith(signal('turnFinished'));

        tracker.observe(signal('turnFinished', 'subagent-1'));
        expect(onDeferredParentFinished).toHaveBeenCalledOnce();
    });

    it('extends deferred completion while a subagent keeps reporting activity', () => {
        vi.useFakeTimers();
        const onDeferredParentFinished = vi.fn();
        const tracker = new AgentWorkTracker(onDeferredParentFinished, {
            staleTimeoutMs: 1_000,
        });

        tracker.observe(signal('subagentStarted', 'subagent-1'));
        tracker.observe(signal('turnFinished'));
        vi.advanceTimersByTime(750);
        tracker.observe(signal('shellToolStarted', 'subagent-1'));
        vi.advanceTimersByTime(750);

        expect(onDeferredParentFinished).not.toHaveBeenCalled();
        vi.advanceTimersByTime(250);
        expect(onDeferredParentFinished).toHaveBeenCalledOnce();
    });
});
