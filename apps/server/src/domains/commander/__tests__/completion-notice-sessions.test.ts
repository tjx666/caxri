import type { AgentDelegationReceipt } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Fixture } from './completion-notice.fixture';
import { COMMANDER_TERMINAL_ID, fixture } from './completion-notice.fixture';

function receipt(overrides: Partial<AgentDelegationReceipt> = {}): AgentDelegationReceipt {
    return {
        delegationId: 'delegation-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        callerTerminalId: COMMANDER_TERMINAL_ID,
        provider: 'codex',
        status: 'running',
        revision: 1,
        createdAt: 1,
        updatedAt: 2,
        ...overrides,
    };
}

describe('CommanderCompletionNotifier managed Session notices', () => {
    let f: Fixture;

    beforeEach(() => {
        vi.useFakeTimers();
        f = fixture();
        // An idle Commander whose last turn finished, so a settled batch goes out at once.
        f.startTurn('launch-1');
        f.finishTurn('launch-1', 'turn-1');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const change = (sessionId: string, to: 'completed' | 'running' | 'unknown' | 'waiting') =>
        f.notifier.notifySessionActivity({ sessionId, from: 'idle', to });

    it('batches changes until the managed Sessions go quiet, keeping each latest state', () => {
        change('session-1', 'running');
        vi.advanceTimersByTime(3000);
        change('session-2', 'waiting');
        change('session-1', 'completed');
        vi.advanceTimersByTime(4999);
        expect(f.writeCalls).toHaveLength(0);

        vi.advanceTimersByTime(1);
        expect(f.writeCalls.map((call) => call.data)).toEqual([
            '[Caxri notice] 2 Session updates: Session session-1 finished its turn; Session session-2 needs input.',
        ]);
    });

    it('sends a Session that keeps changing within the maximum wait', () => {
        for (let second = 0; second < 40; second += 2) {
            change('session-1', second % 4 === 0 ? 'running' : 'completed');
            vi.advanceTimersByTime(2000);
            if (second < 28) expect(f.writeCalls).toHaveLength(0);
        }
        expect(f.writeCalls[0]?.data).toContain('Session session-1');
    });

    it('holds a settled batch while the Commander is busy and adds later changes to it', () => {
        f.startTurn('launch-1');
        change('session-1', 'running');
        vi.advanceTimersByTime(5000);
        change('session-2', 'completed');
        change('session-1', 'completed');
        expect(f.writeCalls).toHaveLength(0);

        f.finishTurn('launch-1', 'turn-2');
        expect(f.writeCalls.map((call) => call.data)).toEqual([
            '[Caxri notice] 2 Session updates: Session session-1 finished its turn; Session session-2 finished its turn.',
        ]);
    });

    it('lets an unsettled change ride along with another notice instead of a second line', () => {
        change('session-2', 'running');
        f.notifier.notifyInbox('item-1', 'replied');
        expect(f.writeCalls.map((call) => call.data)).toEqual([
            '[Caxri notice] 2 updates: inbox item item-1 has a new reply; Session session-2 is working.',
        ]);
        vi.advanceTimersByTime(30_000);
        expect(f.writeCalls).toHaveLength(1);
    });

    it('skips the Commander itself, unmanaged Sessions, unknown states, and delegated Sessions', () => {
        change('commander-session', 'running');
        change('session-9', 'running');
        change('session-2', 'unknown');
        f.notifier.notifyReceiptChanged(receipt());
        change('session-1', 'running');
        vi.advanceTimersByTime(30_000);
        expect(f.writeCalls).toHaveLength(0);

        // The task settled: its notice reports the Session, and its own activity change shortly after is not repeated.
        f.notifier.notifyReceiptChanged(receipt({ status: 'completed', revision: 2 }));
        change('session-1', 'completed');
        vi.advanceTimersByTime(5000);
        expect(f.writeCalls.map((call) => call.data)).toEqual([
            '[Caxri notice] 1 delegation update: delegation delegation-1 in Session session-1 completed.',
        ]);

        f.startTurn('launch-1');
        f.finishTurn('launch-1', 'turn-2');
        vi.advanceTimersByTime(10_000);
        change('session-1', 'running');
        vi.advanceTimersByTime(5000);
        expect(f.writeCalls.at(-1)?.data).toBe(
            '[Caxri notice] 1 Session update: Session session-1 is working.',
        );
    });

    it('carries unsent changes in a relaunched Commander’s launch prompt, settled once it runs', () => {
        change('session-1', 'completed');
        const prompt = f.notifier.launchPrompt(COMMANDER_TERMINAL_ID);
        expect(prompt).toContain('Missed 1 Session update: Session session-1 finished its turn.');
        f.notifier.onLaunched(COMMANDER_TERMINAL_ID, true);
        vi.advanceTimersByTime(30_000);
        expect(f.writeCalls).toHaveLength(0);
        expect(f.notifier.launchPrompt(COMMANDER_TERMINAL_ID)).toBeUndefined();
    });
});
