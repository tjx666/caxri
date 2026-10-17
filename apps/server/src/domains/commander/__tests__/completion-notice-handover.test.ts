import { beforeEach, describe, expect, it } from 'vitest';

import type { Fixture } from './completion-notice.fixture';
import { COMMANDER_TERMINAL_ID, fixture } from './completion-notice.fixture';

describe('CommanderCompletionNotifier hand-over notices', () => {
    let f: Fixture;

    beforeEach(() => {
        f = fixture();
    });

    it('forgets only updates belonging to returned hand-overs', () => {
        f.rows.terminalId = undefined;
        f.notifier.notifyHandover({
            handoverId: 'returned',
            sessionId: 'session-1',
            event: 'busy',
        });
        f.notifier.notifyHandover({
            handoverId: 'retained',
            sessionId: 'session-2',
            event: 'ready',
        });
        f.notifier.onStopped();
        f.notifier.forgetHandovers(['returned']);
        f.rows.terminalId = COMMANDER_TERMINAL_ID;
        const prompt = f.notifier.launchPrompt(COMMANDER_TERMINAL_ID);
        expect(prompt).not.toContain('hand-over returned');
        expect(prompt).toContain('hand-over retained');
    });

    it('keeps owed notices when a stopped launch reports delivery late', () => {
        f.rows.terminalId = undefined;
        f.notifier.notifyHandover({ handoverId: 'owed', sessionId: 'session-1', event: 'ready' });
        f.rows.terminalId = COMMANDER_TERMINAL_ID;
        expect(f.notifier.launchPrompt(COMMANDER_TERMINAL_ID)).toContain('hand-over owed');
        f.notifier.onStopped();
        f.notifier.onLaunched(COMMANDER_TERMINAL_ID, true);
        expect(f.notifier.launchPrompt(COMMANDER_TERMINAL_ID)).toContain('hand-over owed');
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
        f.notifier.onLaunched(COMMANDER_TERMINAL_ID, true);
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
});
