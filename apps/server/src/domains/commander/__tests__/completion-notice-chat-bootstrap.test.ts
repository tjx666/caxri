import { describe, expect, it } from 'vitest';

import { COMMANDER_TERMINAL_ID, fixture } from './completion-notice.fixture';

const handover = (handoverId: string) => ({
    handoverId,
    sessionId: 'session-1',
    event: 'ready' as const,
});

describe('Commander Chat first notification', () => {
    it('resumes an interrupted turn even when no delegation or hand-over is owed', () => {
        const f = fixture();
        f.notices.markTurnStarted(1);
        f.delayedDeliveries = [];
        f.notifier.onChatReady(COMMANDER_TERMINAL_ID, 'launch-1');
        expect(f.writeCalls).toHaveLength(1);
        f.startTurn('launch-1');
        f.delayedDeliveries[0]?.(true);
        expect(f.notices.list()).toEqual([expect.objectContaining({ kind: 'interrupted_turn' })]);
        f.finishTurn('launch-1', 'notice-turn-1');
        expect(f.notices.list()).toHaveLength(0);
    });

    it('submits a hand-over arriving after an empty Chat became ready without a human turn', () => {
        const f = fixture();
        f.notifier.onChatReady(COMMANDER_TERMINAL_ID, 'launch-1');
        expect(f.writeCalls).toHaveLength(0);
        f.notifier.notifyHandover(handover('handover-1'));
        expect(f.writeCalls).toHaveLength(1);
        expect(f.writeCalls[0]?.data).toContain('handover-1');
        expect(f.writeCalls[0]?.data).not.toContain('restarted');
        f.notifier.notifyHandover(handover('handover-2'));
        f.notifier.onChatReady(COMMANDER_TERMINAL_ID, 'launch-1');
        expect(f.writeCalls).toHaveLength(1);
        f.startTurn('launch-1');
        f.finishTurn('launch-1', 'notice-turn-1');
        expect(f.writeCalls).toHaveLength(2);
        expect(f.writeCalls[1]?.data).toContain('handover-2');
        expect(f.writeCalls[1]?.data).not.toContain('handover-1');
    });

    it('keeps the notice turn baseline when Chat acceptance arrives after turnStarted', () => {
        const f = fixture();
        f.delayedDeliveries = [];
        f.notifier.onChatReady(COMMANDER_TERMINAL_ID, 'launch-1');
        f.notifier.notifyHandover(handover('handover-1'));
        f.startTurn('launch-1');
        f.notifier.notifyHandover(handover('handover-2'));
        f.notifier.onChatReady(COMMANDER_TERMINAL_ID, 'launch-1');
        expect(f.writeCalls).toHaveLength(1);
        f.delayedDeliveries[0]?.(true);
        f.finishTurn('launch-1', 'notice-turn-1');
        expect(f.writeCalls).toHaveLength(2);
        expect(f.writeCalls[1]?.data).toContain('handover-2');
        expect(f.writeCalls[1]?.data).not.toContain('handover-1');
    });

    it('flushes notices owed during an in-flight submission once that turn has already finished', () => {
        const f = fixture();
        f.delayedDeliveries = [];
        f.notifier.onChatReady(COMMANDER_TERMINAL_ID, 'launch-1');
        f.notifier.notifyHandover(handover('handover-1'));
        f.startTurn('launch-1');
        f.notifier.notifyHandover(handover('handover-2'));
        f.finishTurn('launch-1', 'notice-turn-1');
        expect(f.writeCalls).toHaveLength(1);
        f.delayedDeliveries[0]?.(true);
        expect(f.writeCalls).toHaveLength(2);
        expect(f.writeCalls[1]?.data).not.toContain('handover-1');
    });

    it('does not bootstrap over a human turn that started before readiness was published', () => {
        const f = fixture();
        f.startTurn('launch-1');
        f.notifier.onChatReady(COMMANDER_TERMINAL_ID, 'launch-1');
        f.notifier.notifyHandover(handover('handover-1'));
        expect(f.writeCalls).toHaveLength(0);
        f.finishTurn('launch-1', 'human-turn-1');
        expect(f.writeCalls).toHaveLength(1);
    });

    it('ignores acceptance from a replaced Chat launch without settling its newer claim', () => {
        const f = fixture();
        f.delayedDeliveries = [];
        f.notifier.onChatReady(COMMANDER_TERMINAL_ID, 'launch-1');
        f.notifier.notifyHandover(handover('handover-1'));
        f.notifier.onChatReady(COMMANDER_TERMINAL_ID, 'launch-2');
        expect(f.writeCalls).toHaveLength(2);
        f.delayedDeliveries[0]?.(true);
        f.startTurn('launch-2');
        f.notifier.notifyHandover(handover('handover-2'));
        f.delayedDeliveries[1]?.(true);
        f.finishTurn('launch-2', 'notice-turn-2');
        expect(f.writeCalls).toHaveLength(3);
        expect(f.writeCalls[2]?.data).toContain('handover-2');
        expect(f.writeCalls[2]?.data).not.toContain('handover-1');
    });
});
