import { describe, expect, it, vi } from 'vitest';

import { QUIET_MS, RECHECK_MS, setup } from './settlement-notice.fixture';

describe('SettlementNotices: Chat caller', () => {
    it('writes one fixed notice after the quiet window and records it delivered', async () => {
        const t = await setup();
        const id = await t.create('Fix the build');

        t.settle(id);
        expect(t.stateOf(`settled:${id}`)).toBe('pending');
        await vi.advanceTimersByTimeAsync(QUIET_MS - 1);
        expect(t.deliverNotice).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(t.deliverNotice).toHaveBeenCalledWith(
            t.callerTerminalId,
            'caller-launch',
            expect.stringContaining(`- ${id} "Fix the build" completed`),
            expect.any(Function),
        );
        expect(t.stateOf(`settled:${id}`)).toBe('unknown');
        t.deliveries[0].done(true);
        expect(t.stateOf(`settled:${id}`)).toBe('delivered');
        expect(t.logged('delivered')).toHaveLength(1);
    });

    it('sends the settled tasks of one quiet window as one message', async () => {
        const t = await setup();
        const first = await t.create();
        const second = await t.create();

        t.settle(first);
        await vi.advanceTimersByTimeAsync(QUIET_MS / 2);
        t.settle(second);
        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.deliverNotice).toHaveBeenCalledTimes(1);
        expect(t.deliveries[0].text).toContain(first);
        expect(t.deliveries[0].text).toContain(second);
    });

    it('waits while the caller is in a turn and sends when its Chat goes idle', async () => {
        const t = await setup();
        const id = await t.create();
        t.state.chat = 'busy';

        t.settle(id);
        await vi.advanceTimersByTimeAsync(QUIET_MS);
        expect(t.deliverNotice).not.toHaveBeenCalled();
        expect(t.stateOf(`settled:${id}`)).toBe('pending');

        t.state.chat = 'idle';
        t.notices.chatChanged(t.callerTerminalId);
        await vi.advanceTimersByTimeAsync(1);

        expect(t.deliverNotice).toHaveBeenCalledTimes(1);
    });

    it('re-checks a held notice on its own when no event announces the change', async () => {
        const t = await setup();
        const id = await t.create();
        t.state.chat = 'paused';
        t.settle(id);
        await vi.advanceTimersByTimeAsync(QUIET_MS);
        t.state.chat = 'idle';

        await vi.advanceTimersByTimeAsync(RECHECK_MS);

        expect(t.deliverNotice).toHaveBeenCalledTimes(1);
        expect(t.logged('deferred')).toHaveLength(1);
    });

    it('never sends a notice again once its write may have reached the Chat', async () => {
        const t = await setup();
        const id = await t.create();
        t.settle(id);
        await vi.advanceTimersByTimeAsync(QUIET_MS);

        t.deliveries[0].done(false);
        await vi.advanceTimersByTimeAsync(RECHECK_MS * 3);

        expect(t.deliverNotice).toHaveBeenCalledTimes(1);
        expect(t.stateOf(`settled:${id}`)).toBe('unknown');
        expect(t.logged('unknown')).toHaveLength(1);
    });

    it('tries again when the write was refused before anything was sent', async () => {
        const t = await setup();
        const id = await t.create();
        t.deliverNotice.mockReturnValueOnce(false);
        t.settle(id);

        await vi.advanceTimersByTimeAsync(QUIET_MS);
        expect(t.stateOf(`settled:${id}`)).toBe('pending');
        await vi.advanceTimersByTimeAsync(RECHECK_MS);

        expect(t.deliverNotice).toHaveBeenCalledTimes(2);
    });

    it('does not write into the same idle-looking Chat twice before it shows a turn', async () => {
        const t = await setup();
        const first = await t.create();
        t.settle(first);
        await vi.advanceTimersByTimeAsync(QUIET_MS);
        t.deliveries[0].done(true);
        const second = await t.create();

        t.settle(second);
        await vi.advanceTimersByTimeAsync(QUIET_MS + RECHECK_MS);
        expect(t.deliverNotice).toHaveBeenCalledTimes(1);

        t.state.chat = 'busy';
        t.notices.chatChanged(t.callerTerminalId);
        t.state.chat = 'idle';
        t.notices.chatChanged(t.callerTerminalId);
        await vi.advanceTimersByTimeAsync(1);

        expect(t.deliverNotice).toHaveBeenCalledTimes(2);
    });
});

describe('SettlementNotices: what is not announced', () => {
    it('skips an outcome the caller read itself through wait or result', async () => {
        const t = await setup();
        const id = await t.create();
        t.settle(id);

        t.notices.readOutcome(t.stored(id), { callerTerminalId: t.callerTerminalId });
        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.deliverNotice).not.toHaveBeenCalled();
        expect(t.stateOf(`settled:${id}`)).toBe('skipped');
    });

    it('ignores a read by another Terminal', async () => {
        const t = await setup();
        const id = await t.create();
        t.settle(id);

        t.notices.readOutcome(t.stored(id), { callerTerminalId: 'another-terminal' });
        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.deliverNotice).toHaveBeenCalledTimes(1);
    });

    it('holds the notice while a wait of the caller is open and sends it when the wait ends', async () => {
        const t = await setup();
        const id = await t.create();
        const release = t.notices.waiting({ callerTerminalId: t.callerTerminalId }, [id], false);
        t.settle(id);
        await vi.advanceTimersByTimeAsync(QUIET_MS);
        expect(t.deliverNotice).not.toHaveBeenCalled();

        release();
        await vi.advanceTimersByTimeAsync(1);

        expect(t.deliverNotice).toHaveBeenCalledTimes(1);
    });

    it('records a read made before the notice was registered, so a cancelled retry plan stays quiet', async () => {
        const t = await setup();
        const id = await t.create();
        const before = t.database.agentDelegations.get(id)!;
        const retried = t.database.agentDelegations.save({
            ...before,
            receipt: {
                ...before.receipt,
                status: 'failed',
                failure: 'quota_exhausted',
                retriedAs: 'retry-1',
            },
        });
        t.notices.recorded(retried, before.receipt);
        expect(t.stateOf(`settled:${id}`)).toBeUndefined();

        t.notices.readOutcome(retried, { callerTerminalId: t.callerTerminalId });
        t.settle(id, 'failed', { retriedAs: undefined });
        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.deliverNotice).not.toHaveBeenCalled();
    });

    it('leaves a failed task whose retry is planned to its successor, and notices it if the plan is cancelled', async () => {
        const t = await setup();
        const id = await t.create();
        const before = t.database.agentDelegations.get(id)!;
        const planned = t.database.agentDelegations.save({
            ...before,
            receipt: {
                ...before.receipt,
                status: 'failed',
                failure: 'quota_exhausted',
                retriedAs: 'retry-1',
            },
        });
        t.notices.recorded(planned, before.receipt);
        await vi.advanceTimersByTimeAsync(QUIET_MS);
        expect(t.deliverNotice).not.toHaveBeenCalled();
        expect(t.logged('skipped')).toHaveLength(1);

        const cancelled = t.database.agentDelegations.save({
            ...planned,
            receipt: { ...planned.receipt, retriedAs: undefined },
        });
        t.notices.recorded(cancelled, planned.receipt);
        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.deliverNotice).toHaveBeenCalledTimes(1);
    });

    it('drops a pending notice whose retry was planned after it was registered', async () => {
        const t = await setup();
        const id = await t.create();
        t.settle(id, 'failed');
        const failed = t.database.agentDelegations.get(id)!;
        t.database.agentDelegations.save({
            ...failed,
            receipt: { ...failed.receipt, retriedAs: 'retry-1' },
        });

        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.deliverNotice).not.toHaveBeenCalled();
        expect(t.stateOf(`settled:${id}`)).toBeUndefined();
    });

    it('skips a notice owed to a launch that is no longer the caller', async () => {
        const t = await setup();
        const id = await t.create();
        t.settle(id);
        t.state.launch = 'another-launch';

        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.deliverNotice).not.toHaveBeenCalled();
        expect(t.stateOf(`settled:${id}`)).toBe('skipped');
    });

    it('skips a notice owed to a Terminal that no longer exists', async () => {
        const t = await setup();
        const id = await t.create();
        t.settle(id);
        t.database.closeTerminal(t.callerTerminalId);

        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.stateOf(`settled:${id}`)).toBe('skipped');
    });

    it('does not notify a task of an external client', async () => {
        const t = await setup();
        const id = await t.create();
        const before = t.database.agentDelegations.get(id)!;
        const external = t.database.agentDelegations.save({
            ...before,
            principal: { kind: 'human-cli', id: 'cli' } as never,
            receipt: { ...before.receipt, status: 'completed' },
        });

        t.notices.recorded(external, before.receipt);
        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.deliverNotice).not.toHaveBeenCalled();
        expect(t.stateOf(`settled:${id}`)).toBeUndefined();
    });
});
