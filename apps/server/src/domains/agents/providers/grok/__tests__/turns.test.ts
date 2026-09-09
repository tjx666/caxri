import { expect, it } from 'vitest';

import type { AgentLifecycleSignal } from '../../../hooks/contract';
import { GrokTurnTracker } from '../turns';

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
