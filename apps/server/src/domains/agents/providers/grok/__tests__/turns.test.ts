import { expect, it } from 'vitest';

import type { AgentLifecycleSignal } from '../../../hooks/contract';
import { GrokTurnTracker } from '../turns';

it('retains repeated delegated Stops until a new turn or failed generation', () => {
    const tracker = new GrokTurnTracker();
    const base: AgentLifecycleSignal = {
        provider: 'grok',
        terminalId: 'one',
        launchId: 'launch',
        agentSessionId: 'session',
        agentTurnId: 'turn-one',
        phase: 'turnStarted',
    };
    tracker.accept(base, 'session');
    const stop = { ...base, phase: 'turnFinished' as const, agentResponseDigest: 'a'.repeat(64) };
    expect(tracker.accept({ ...stop, agentTurnContinues: true }, 'session')).toBe(true);
    expect(tracker.accept(stop, 'session')).toBe(true);
    expect(tracker.accept(stop, 'session')).toBe(true);
    expect(tracker.accept({ ...base, agentTurnId: 'turn-two' }, 'session')).toBe(true);
    expect(tracker.accept(stop, 'session')).toBe(false);
    expect(
        tracker.accept({ ...base, agentTurnId: 'turn-two', phase: 'turnFailed' }, 'session'),
    ).toBe(true);
    expect(tracker.accept({ ...stop, agentTurnId: 'turn-two' }, 'session')).toBe(false);
});

it('isolates replaced Grok sessions, overlapping turns and terminal lifetimes', () => {
    const tracker = new GrokTurnTracker();
    const signal: AgentLifecycleSignal = {
        provider: 'grok',
        terminalId: 'one',
        launchId: 'launch',
        agentSessionId: 'session',
        agentTurnId: 'turn-one',
        phase: 'turnStarted',
    };
    expect(tracker.accept(signal, 'session')).toBe(true);
    expect(tracker.accept({ ...signal, agentTurnId: undefined }, 'session')).toBe(false);
    expect(tracker.accept({ ...signal, terminalId: 'two', phase: 'turnFinished' }, 'session')).toBe(
        false,
    );
    expect(tracker.accept({ ...signal, agentTurnId: 'turn-two' }, 'session')).toBe(true);
    expect(tracker.accept({ ...signal, phase: 'turnFinished' }, 'session')).toBe(false);
    expect(
        tracker.accept({ ...signal, agentTurnId: 'turn-two', phase: 'turnFailed' }, 'session'),
    ).toBe(true);
    expect(tracker.accept({ ...signal, phase: 'turnFinished' }, 'replaced-session')).toBe(false);
    tracker.accept(signal, 'session');
    tracker.forget('one');
    expect(tracker.accept({ ...signal, phase: 'turnFinished' }, 'session')).toBe(false);
});
