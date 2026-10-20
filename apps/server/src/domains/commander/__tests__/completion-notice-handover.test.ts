import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Fixture } from './completion-notice.fixture';
import { COMMANDER_TERMINAL_ID, fixture, signal } from './completion-notice.fixture';

describe('CommanderCompletionNotifier hand-over notices', () => {
    let f: Fixture;

    beforeEach(() => {
        f = fixture();
    });

    it('delivers hand-over events at the next idle point and carries unsent ones in the launch prompt', () => {
        f.rows.terminalId = undefined;
        f.notifier.notifyHandover({
            handoverId: 'handover-1',
            sessionId: 'session-1',
            event: 'busy',
        });
        f.notifier.notifyHandover({
            handoverId: 'handover-1',
            sessionId: 'session-1',
            event: 'ready',
        });
        f.rows.terminalId = COMMANDER_TERMINAL_ID;
        expect(f.notifier.launchPrompt(COMMANDER_TERMINAL_ID)).toContain(
            'Missed 1 hand-over update: hand-over handover-1 of Session session-1 is ready to continue',
        );
        f.notifier.onLaunched(COMMANDER_TERMINAL_ID, 'launch-2');
        expect(f.notifier.launchPrompt(COMMANDER_TERMINAL_ID)).toBeUndefined();
        f.startTurn('launch-1');
        f.notifier.notifyHandover({
            handoverId: 'handover-2',
            sessionId: 'session-2',
            event: 'ownership_only',
        });
        expect(f.writeCalls).toHaveLength(0);
        f.finishTurn('launch-1', 'turn-1');
        expect(f.writeCalls.at(-1)?.data).toContain('hand-over handover-2 of Session session-2');
    });

    const ready = { handoverId: 'handover-1', sessionId: 'session-1', event: 'ready' } as const;

    it('tells a Chat Commander that launched with nothing to say, once its Chat is ready', () => {
        f.notifier.onChatReady(COMMANDER_TERMINAL_ID);
        expect(f.writeCalls).toHaveLength(0);
        f.notifier.notifyHandover(ready);
        expect(f.writeCalls.at(-1)?.data).toContain('hand-over handover-1 of Session session-1');

        // The first delivery spends the fresh launch, as a finished turn's proof is spent: the next needs a turn.
        f.notifier.notifyHandover({ ...ready, handoverId: 'handover-2' });
        expect(f.writeCalls).toHaveLength(1);
        f.startTurn('launch-1');
        f.finishTurn('launch-1', 'turn-1');
        expect(f.writeCalls.at(-1)?.data).toContain('hand-over handover-2');
    });

    it('tells a Terminal Commander that started with nothing to say, once its session started', () => {
        f.notifier.onLaunched(COMMANDER_TERMINAL_ID, 'launch-2');
        f.notifier.notifyHandover(ready);
        expect(f.writeCalls).toHaveLength(0);
        f.notifier.onLifecycleApplied(signal({ phase: 'sessionIdentified', launchId: 'launch-2' }));
        expect(f.writeCalls.at(-1)).toMatchObject({ launchId: 'launch-2' });
    });

    describe('a Terminal Commander whose Agent reports no SessionStart until its first prompt (Codex)', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('is told once its launch stayed silent long enough to be waiting at its first prompt', () => {
            f.notifier.onLaunched(COMMANDER_TERMINAL_ID, 'launch-2');
            f.notifier.notifyHandover(ready);
            vi.advanceTimersByTime(7999);
            expect(f.writeCalls).toHaveLength(0);
            vi.advanceTimersByTime(1);
            expect(f.writeCalls.at(-1)).toMatchObject({ launchId: 'launch-2' });
            expect(f.writeCalls.at(-1)?.data).toContain('hand-over handover-1');
        });

        it.each([
            ['the user typed into it', (g: Fixture) => g.type()],
            ['its first turn started', (g: Fixture) => g.startTurn('launch-2')],
        ])('is not taken as idle when %s before the wait ran out', (_, act) => {
            f.notifier.onLaunched(COMMANDER_TERMINAL_ID, 'launch-2');
            act(f);
            f.notifier.notifyHandover(ready);
            vi.advanceTimersByTime(8000);
            expect(f.writeCalls).toHaveLength(0);
        });
    });

    it.each([
        ['types after the session started', (g: Fixture) => g.type()],
        ['starts a turn', (g: Fixture) => g.startTurn('launch-2')],
    ])('keeps waiting when the user of a freshly started Commander %s', (_, act) => {
        f.notifier.onLaunched(COMMANDER_TERMINAL_ID, 'launch-2');
        f.notifier.onLifecycleApplied(signal({ phase: 'sessionIdentified', launchId: 'launch-2' }));
        act(f);
        f.notifier.notifyHandover(ready);
        expect(f.writeCalls).toHaveLength(0);
    });

    it('takes no SessionStart as idle after typing, or one that did not follow a launch without a prompt', () => {
        // A provider that fires SessionStart lazily fires it as the user's first prompt goes in.
        f.notifier.onLaunched(COMMANDER_TERMINAL_ID, 'launch-2');
        f.type();
        f.notifier.onLifecycleApplied(signal({ phase: 'sessionIdentified', launchId: 'launch-2' }));
        f.notifier.notifyHandover(ready);
        // `/clear` or compaction in a Commander that launched with a prompt.
        const g = fixture();
        g.notifier.notifyInbox('item-1', 'replied');
        g.notifier.launchPrompt(COMMANDER_TERMINAL_ID);
        g.notifier.onLaunched(COMMANDER_TERMINAL_ID, 'launch-2');
        g.notifier.onLifecycleApplied(signal({ phase: 'sessionIdentified', launchId: 'launch-2' }));
        g.notifier.notifyHandover(ready);
        expect([f.writeCalls, g.writeCalls]).toEqual([[], []]);
    });
});
