import { randomUUID } from 'node:crypto';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { SettlementNotices } from '../settlement-notice/service';
import { fixture } from './retry.fixture';
import { passSignal, QUIET_MS, RECHECK_MS, setup } from './settlement-notice.fixture';

describe('SettlementNotices: questions and approvals', () => {
    it('wakes the caller for a question that still waits on it', async () => {
        const t = await setup();
        const id = await t.create();
        t.state.isQuestionOpen = true;

        t.notices.questionChanged({
            sessionId: t.stored(id).receipt.sessionId,
            delegationId: id,
            questionId: 'question-1',
            state: 'open',
            escalated: false,
        });
        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.deliveries[0].text).toContain('is asking you a question');
        expect(t.deliveries[0].text).toContain('caxri agent delegate questions <id> --json');
    });

    it('drops a question answered or shown to the user before the notice went out', async () => {
        const t = await setup();
        const id = await t.create();
        t.state.isQuestionOpen = true;
        t.notices.questionChanged({
            sessionId: t.stored(id).receipt.sessionId,
            delegationId: id,
            questionId: 'question-1',
            state: 'open',
            escalated: false,
        });
        t.state.isQuestionOpen = false;

        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.deliverNotice).not.toHaveBeenCalled();
        expect(t.stateOf('question:question-1')).toBe('skipped');
    });

    it('does not announce a question while the caller waits for questions itself', async () => {
        const t = await setup();
        const id = await t.create();
        t.state.isQuestionOpen = true;
        const release = t.notices.waiting({ callerTerminalId: t.callerTerminalId }, [id], false);
        t.notices.questionChanged({
            sessionId: t.stored(id).receipt.sessionId,
            delegationId: id,
            questionId: 'question-1',
            state: 'open',
            escalated: false,
        });
        await vi.advanceTimersByTimeAsync(QUIET_MS);
        expect(t.deliverNotice).not.toHaveBeenCalled();

        release();
        await vi.advanceTimersByTimeAsync(1);

        expect(t.deliverNotice).toHaveBeenCalledTimes(1);
    });

    it('lets a wait that ignores questions leave the question to the notice', async () => {
        const t = await setup();
        const id = await t.create();
        t.state.isQuestionOpen = true;
        t.notices.waiting({ callerTerminalId: t.callerTerminalId }, [id], true);
        t.notices.questionChanged({
            sessionId: t.stored(id).receipt.sessionId,
            delegationId: id,
            questionId: 'question-1',
            state: 'open',
            escalated: false,
        });

        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.deliverNotice).toHaveBeenCalledTimes(1);
    });

    it('wakes the caller for a permission request it may decide, and only while it may', async () => {
        const t = await setup();
        const id = await t.create();
        const change = {
            sessionId: t.stored(id).receipt.sessionId,
            delegationId: id,
            requestId: 'request-1',
        };
        t.state.isDecidable = true;
        t.notices.approvalChanged({ ...change, state: 'pending' });
        await vi.advanceTimersByTimeAsync(QUIET_MS);
        expect(t.deliveries[0].text).toContain('needs your approval');
        expect(t.deliveries[0].text).toContain('caxri agent delegate status <id> --json');

        t.state.isDecidable = false;
        t.notices.approvalChanged({ ...change, requestId: 'request-2', state: 'pending' });
        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.deliverNotice).toHaveBeenCalledTimes(1);
        expect(t.stateOf(`approval:${id}:request-2`)).toBe('skipped');
    });

    it('registers a question once however many times it is reported', async () => {
        const t = await setup();
        const id = await t.create();
        t.state.isQuestionOpen = true;
        const change = {
            sessionId: t.stored(id).receipt.sessionId,
            delegationId: id,
            questionId: 'question-1',
            state: 'open' as const,
            escalated: false,
        };

        t.notices.questionChanged(change);
        t.notices.questionChanged(change);
        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.logged('pending')).toHaveLength(1);
        expect(t.deliverNotice).toHaveBeenCalledTimes(1);
    });
});

describe('SettlementNotices: PTY caller', () => {
    it('waits for a finished turn that is proven idle', async () => {
        const t = await setup({ isChat: false });
        const id = await t.create();
        t.settle(id);
        await vi.advanceTimersByTimeAsync(QUIET_MS);
        expect(t.deliverNotice).not.toHaveBeenCalled();
        expect(t.logged('deferred')).toHaveLength(1);

        t.notices.observe(passSignal(t.callerTerminalId, 'turnStarted'));
        t.notices.observe(passSignal(t.callerTerminalId, 'turnFinished'));
        await vi.advanceTimersByTimeAsync(1000);

        expect(t.deliverNotice).toHaveBeenCalledTimes(1);
    });

    it('does not paste over a line the user typed and did not submit', async () => {
        const t = await setup({ isChat: false });
        const id = await t.create();
        t.notices.observe(passSignal(t.callerTerminalId, 'turnStarted'));
        t.notices.observe(passSignal(t.callerTerminalId, 'turnFinished'));
        t.state.epoch = 3;
        t.notices.observeInput(t.callerTerminalId, 'half a sent');
        t.settle(id);

        await vi.advanceTimersByTimeAsync(QUIET_MS + RECHECK_MS);

        expect(t.deliverNotice).not.toHaveBeenCalled();
    });

    it('writes into a prompt the user submitted and left empty', async () => {
        const t = await setup({ isChat: false });
        const id = await t.create();
        t.notices.observe(passSignal(t.callerTerminalId, 'turnStarted'));
        t.notices.observe(passSignal(t.callerTerminalId, 'turnFinished'));
        t.state.epoch = 3;
        t.notices.observeInput(t.callerTerminalId, '\r');
        t.settle(id);

        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.deliverNotice).toHaveBeenCalledTimes(1);
    });

    it('spends the idle proof, so the next notice waits for the next finished turn', async () => {
        const t = await setup({ isChat: false });
        const first = await t.create();
        t.notices.observe(passSignal(t.callerTerminalId, 'turnStarted'));
        t.notices.observe(passSignal(t.callerTerminalId, 'turnFinished'));
        t.settle(first);
        await vi.advanceTimersByTimeAsync(QUIET_MS);
        t.deliveries[0].done(true);
        const second = await t.create();

        t.settle(second);
        await vi.advanceTimersByTimeAsync(QUIET_MS + RECHECK_MS);

        expect(t.deliverNotice).toHaveBeenCalledTimes(1);
    });
});

describe('SettlementNotices: restart and suspension hold', () => {
    it('re-checks a pending notice after a restart and sends it', async () => {
        const t = await setup();
        const id = await t.create();
        t.database.agentDelegations.notices.register({
            id: `settled:${id}`,
            delegationId: id,
            kind: 'settled',
            callerTerminalId: t.callerTerminalId,
            callerLaunchId: 'caller-launch',
            now: Date.now(),
        });
        t.settle(id);
        t.notices.close();
        const restarted = new SettlementNotices(
            {
                database: t.database,
                currentLaunchId: () => 'caller-launch',
                isChatTerminal: () => true,
                chatCallerState: () => 'idle',
                deliverNotice: t.deliverNotice,
                noticeTiming: { quietMs: QUIET_MS, recheckMs: RECHECK_MS },
            },
            { isApprovalDecidable: () => false, isQuestionWithParent: () => false },
        );
        onTestFinished(() => restarted.close());

        restarted.initialize();
        await vi.advanceTimersByTimeAsync(QUIET_MS);

        expect(t.deliverNotice).toHaveBeenCalledTimes(1);
    });

    it('holds the caller awake while a task it delegated runs and while a notice is owed', async () => {
        const t = await setup();
        expect(t.notices.holds(t.callerTerminalId)).toBe(false);
        const id = await t.create();
        expect(t.notices.holds(t.callerTerminalId)).toBe(true);

        t.state.chat = 'busy';
        t.settle(id);
        expect(t.notices.holds(t.callerTerminalId)).toBe(true);

        t.state.chat = 'idle';
        t.notices.chatChanged(t.callerTerminalId);
        await vi.advanceTimersByTimeAsync(1);
        t.deliveries[0].done(true);

        expect(t.notices.holds(t.callerTerminalId)).toBe(false);
    });

    it('does not hold a caller whose launch is not the one that delegated', async () => {
        const t = await setup();
        await t.create();
        t.state.launch = 'another-launch';

        expect(t.notices.holds(t.callerTerminalId)).toBe(false);
    });
});

describe('SettlementNotices: disabled', () => {
    it('does nothing without a delivery', async () => {
        const f = await fixture();
        const id = randomUUID();
        await f.service.create(id, f.authority, {
            projectId: f.project.id,
            provider: 'claude',
            prompt: 'Synthetic task',
            newSession: true,
        });

        f.service.stop(id, f.authority);

        expect(f.database.agentDelegations.notices.pending()).toEqual([]);
        expect(f.service.notices.holds(f.callerTerminalId)).toBe(false);
    });
});
