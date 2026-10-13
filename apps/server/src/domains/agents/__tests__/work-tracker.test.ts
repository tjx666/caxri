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

    describe('reported background work', () => {
        const backgroundFinish = { ...signal('turnFinished'), agentBackgroundWork: true } as const;

        it('holds the completion and drops it when the Agent resumes', () => {
            vi.useFakeTimers();
            const onDeferredParentFinished = vi.fn();
            const tracker = new AgentWorkTracker(onDeferredParentFinished, {
                resumeGraceMs: 1_000,
            });

            expect(tracker.observe(backgroundFinish).deferCompletion).toBe(true);
            expect(tracker.isWaitingOnBackground('terminal-1')).toBe(true);

            tracker.observe(signal('turnStarted'));
            expect(tracker.isWaitingOnBackground('terminal-1')).toBe(false);
            vi.advanceTimersByTime(60 * 60_000);
            expect(onDeferredParentFinished).not.toHaveBeenCalled();
        });

        it('drops the held completion when the main turn fails', () => {
            vi.useFakeTimers();
            const onDeferredParentFinished = vi.fn();
            const tracker = new AgentWorkTracker(onDeferredParentFinished);

            tracker.observe(backgroundFinish);
            expect(tracker.observe(signal('turnFailed')).deferCompletion).toBe(false);
            expect(tracker.isWaitingOnBackground('terminal-1')).toBe(false);
            vi.advanceTimersByTime(60 * 60_000);
            expect(onDeferredParentFinished).not.toHaveBeenCalled();
        });

        it('releases the original finish after the work drains and no turn resumes', () => {
            vi.useFakeTimers();
            const onDeferredParentFinished = vi.fn();
            const tracker = new AgentWorkTracker(onDeferredParentFinished, {
                resumeGraceMs: 1_000,
            });

            tracker.observe(backgroundFinish);
            expect(tracker.observe(signal('turnFinished')).deferCompletion).toBe(true);
            vi.advanceTimersByTime(999);
            expect(onDeferredParentFinished).not.toHaveBeenCalled();

            vi.advanceTimersByTime(1);
            expect(onDeferredParentFinished).toHaveBeenCalledExactlyOnceWith(
                signal('turnFinished'),
            );
            expect(tracker.isWaitingOnBackground('terminal-1')).toBe(false);
        });

        it('settles once the reported work stays silent past the stale window', () => {
            vi.useFakeTimers();
            const onDeferredParentFinished = vi.fn();
            const tracker = new AgentWorkTracker(onDeferredParentFinished, {
                staleTimeoutMs: 5_000,
            });

            tracker.observe(backgroundFinish);
            vi.advanceTimersByTime(5_000);

            expect(onDeferredParentFinished).toHaveBeenCalledExactlyOnceWith(
                signal('turnFinished'),
            );
        });

        it('leaves an ordinary finish without reported work untouched', () => {
            const tracker = new AgentWorkTracker(vi.fn());

            expect(tracker.observe(signal('turnFinished')).deferCompletion).toBe(false);
            expect(tracker.isWaitingOnBackground('terminal-1')).toBe(false);
        });
    });

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
        vi.useFakeTimers();
        const onDeferredParentFinished = vi.fn();
        const tracker = new AgentWorkTracker(onDeferredParentFinished, { resumeGraceMs: 1_000 });

        tracker.observe(signal('subagentStarted', 'subagent-1'));
        tracker.observe(signal('turnFinished'));
        expect(tracker.observe(signal('turnStarted', 'subagent-1'))).toEqual({
            deferCompletion: false,
            outcome: 'accepted',
        });
        tracker.observe(signal('turnFinished', 'subagent-1'));
        vi.advanceTimersByTime(1_000);

        expect(onDeferredParentFinished).toHaveBeenCalledOnce();
    });

    /**
     * Claude Code resumes the main turn itself once its last background subagent stops (`SubagentStop`, then a fresh
     * `UserPromptSubmit` about 100 ms later). The deferred completion must survive that gap unreleased, or the Session
     * flashes `completed` and raises a notification right before the turn continues.
     */
    it('holds the deferred completion for the resumed parent turn after the last subagent stops', () => {
        vi.useFakeTimers();
        const onDeferredParentFinished = vi.fn();
        const tracker = new AgentWorkTracker(onDeferredParentFinished, { resumeGraceMs: 1_000 });

        tracker.observe(signal('subagentStarted', 'subagent-1'));
        expect(tracker.observe(signal('turnFinished')).deferCompletion).toBe(true);
        expect(tracker.observe(signal('turnFinished', 'subagent-1'))).toEqual({
            deferCompletion: false,
            outcome: 'subagentPending',
        });
        expect(onDeferredParentFinished).not.toHaveBeenCalled();

        vi.advanceTimersByTime(100);
        tracker.observe(signal('turnStarted'));
        vi.advanceTimersByTime(1_000);
        expect(onDeferredParentFinished).not.toHaveBeenCalled();

        // The resumed turn settles through its own `Stop`, with no children left to wait for.
        expect(tracker.observe(signal('turnFinished')).deferCompletion).toBe(false);
    });

    it('releases the deferred completion when no parent turn resumes within the grace window', () => {
        vi.useFakeTimers();
        const onDeferredParentFinished = vi.fn();
        const tracker = new AgentWorkTracker(onDeferredParentFinished, { resumeGraceMs: 1_000 });

        tracker.observe(signal('subagentStarted', 'subagent-1'));
        tracker.observe(signal('turnFinished'));
        tracker.observe(signal('turnFinished', 'subagent-1'));

        vi.advanceTimersByTime(999);
        expect(onDeferredParentFinished).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onDeferredParentFinished).toHaveBeenCalledOnce();
        expect(onDeferredParentFinished).toHaveBeenCalledWith(signal('turnFinished'));
    });

    it('cancels the resume grace when a new subagent starts before the parent resumes', () => {
        vi.useFakeTimers();
        const onDeferredParentFinished = vi.fn();
        const tracker = new AgentWorkTracker(onDeferredParentFinished, { resumeGraceMs: 1_000 });

        tracker.observe(signal('subagentStarted', 'subagent-1'));
        tracker.observe(signal('turnFinished'));
        tracker.observe(signal('turnFinished', 'subagent-1'));
        vi.advanceTimersByTime(500);
        tracker.observe(signal('subagentStarted', 'subagent-2'));
        vi.advanceTimersByTime(1_000);
        expect(onDeferredParentFinished).not.toHaveBeenCalled();

        tracker.observe(signal('turnFinished', 'subagent-2'));
        vi.advanceTimersByTime(1_000);
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
            outcome: 'subagentPending',
        });
    });

    it('retires a failed subagent without surfacing it as the parent turn', () => {
        const tracker = new AgentWorkTracker(vi.fn());
        tracker.observe(signal('subagentStarted', 'subagent-1'));
        tracker.observe(signal('subagentStarted', 'subagent-2'));

        expect(tracker.observe(signal('turnFailed', 'subagent-1'))).toEqual({
            deferCompletion: false,
            outcome: 'subagentPending',
        });
        expect(tracker.observe(signal('turnFailed', 'subagent-unknown'))).toEqual({
            deferCompletion: false,
            outcome: 'subagentUnmatched',
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
