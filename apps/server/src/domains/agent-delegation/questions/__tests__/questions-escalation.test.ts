import { QUESTION_ESCALATION_GRACE_MS } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { questionFixture } from './questions.fixture';

afterEach(() => {
    vi.useRealTimers();
});

const escalatedOf = (f: Awaited<ReturnType<typeof questionFixture>>, questionId: string) =>
    f.database.agentDelegations.questions.get(questionId);

describe('escalation after the grace period', () => {
    it('hands the question to the user at exactly the grace period and never answers or cancels it', async () => {
        const f = await questionFixture();
        vi.useFakeTimers();
        const { questionId } = f.ask();

        vi.advanceTimersByTime(QUESTION_ESCALATION_GRACE_MS - 1000);
        expect(escalatedOf(f, questionId)?.escalatedAt).toBeUndefined();
        expect(f.changes).toHaveLength(1);

        f.state.clock += QUESTION_ESCALATION_GRACE_MS;
        vi.advanceTimersByTime(1000);

        expect(escalatedOf(f, questionId)).toMatchObject({
            state: 'open',
            escalationReason: 'grace_elapsed',
            escalatedAt: f.state.clock,
        });
        expect(f.changes.at(-1)).toMatchObject({ questionId, state: 'open', escalated: true });
        expect(f.entries('agent_delegation.question_escalated')).toEqual([
            expect.objectContaining({
                escalationReason: 'grace_elapsed',
                latencyMs: QUESTION_ESCALATION_GRACE_MS,
            }),
        ]);
        expect((await f.sessions([f.callerSessionId]))[0]).toMatchObject({
            question: { questionId, escalated: true },
            waitingOn: 'user',
        });
        // Escalating again, or letting more time pass, changes nothing.
        vi.advanceTimersByTime(QUESTION_ESCALATION_GRACE_MS);
        expect(f.changes).toHaveLength(2);
        expect(f.service.status(f.task.id, f.parent).status).not.toBe('failed');
    });

    it('does not escalate a question that was answered or withdrawn first', async () => {
        const f = await questionFixture();
        vi.useFakeTimers();
        const answered = f.ask();
        f.questions.answer(f.parent, {
            delegationId: f.task.id,
            questionId: answered.questionId,
            text: 'Synthetic',
        });
        const withdrawn = f.ask('Synthetic next');
        f.questions.askCancel(f.child(), withdrawn.questionId);

        vi.advanceTimersByTime(QUESTION_ESCALATION_GRACE_MS * 2);

        expect(f.entries('agent_delegation.question_escalated')).toEqual([]);
        expect(f.changes.map((change) => change.escalated)).not.toContain(true);
    });

    it('lets the delegating Agent still answer an escalated question', async () => {
        const f = await questionFixture();
        vi.useFakeTimers();
        const { questionId } = f.ask();
        vi.advanceTimersByTime(QUESTION_ESCALATION_GRACE_MS);

        expect(
            f.questions.answer(f.parent, {
                delegationId: f.task.id,
                questionId,
                text: 'Synthetic',
            }),
        ).toEqual({ outcome: 'answered' });
        expect(f.questions.list(f.parent).questions).toEqual([]);
    });

    it('stops the timer when the service closes', async () => {
        const f = await questionFixture();
        vi.useFakeTimers();
        f.ask();

        f.service.close();
        vi.advanceTimersByTime(QUESTION_ESCALATION_GRACE_MS * 2);

        expect(f.entries('agent_delegation.question_escalated')).toEqual([]);
    });

    it('keeps the timer when deleting the Session fails, and drops it once the delete succeeds', async () => {
        const f = await questionFixture();
        vi.useFakeTimers();
        const { questionId } = f.ask();
        const childSessionId = f.database.agentDelegations.questions.get(questionId)!.sessionId;

        await expect(
            f.service.deleteSessions([childSessionId], () => {
                throw new Error('synthetic delete failure');
            }),
        ).rejects.toThrow('synthetic delete failure');
        f.state.clock += QUESTION_ESCALATION_GRACE_MS;
        vi.advanceTimersByTime(QUESTION_ESCALATION_GRACE_MS);
        expect(escalatedOf(f, questionId)).toMatchObject({ escalationReason: 'grace_elapsed' });

        const kept = await questionFixture();
        const asked = kept.ask();
        const keptSessionId = kept.database.agentDelegations.questions.get(
            asked.questionId,
        )!.sessionId;
        await kept.service.deleteSessions([keptSessionId], () => {});
        kept.state.clock += QUESTION_ESCALATION_GRACE_MS;
        vi.advanceTimersByTime(QUESTION_ESCALATION_GRACE_MS);
        expect(escalatedOf(kept, asked.questionId)?.escalatedAt).toBeUndefined();
    });
});

describe('escalation when the delegating Agent is gone', () => {
    it('escalates at once when its original launch was replaced before the question', async () => {
        const f = await questionFixture();
        f.launches.set(f.parentTerminalId, 'resumed-launch');

        const { questionId } = f.ask();

        expect(escalatedOf(f, questionId)).toMatchObject({
            state: 'open',
            escalationReason: 'parent_gone',
        });
        expect(f.changes.map((change) => change.escalated)).toEqual([false, true]);
    });

    it('escalates at once when its Terminal was deleted', async () => {
        const f = await questionFixture();
        f.database.closeTerminal(f.parentTerminalId);
        expect(f.database.getTerminal(f.parentTerminalId)).toBeUndefined();

        const { questionId } = f.ask();

        expect(escalatedOf(f, questionId)?.escalationReason).toBe('parent_gone');
    });

    it('escalates an open question when exactly the original launch retires', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask();

        // Another launch of that Terminal, or the user typing, is not the delegating launch ending.
        f.service.interruptTerminal(f.parentTerminalId, false, 'some-other-launch');
        f.service.interruptTerminal(f.parentTerminalId, true);
        expect(escalatedOf(f, questionId)?.escalatedAt).toBeUndefined();

        f.service.interruptTerminal(f.parentTerminalId, false, 'parent-launch');

        expect(escalatedOf(f, questionId)).toMatchObject({
            state: 'open',
            escalationReason: 'parent_gone',
        });
        expect(f.entries('agent_delegation.question_escalated')).toEqual([
            expect.objectContaining({ escalationReason: 'parent_gone' }),
        ]);
    });

    it('does not count a parent that is only starting or suspending as gone', async () => {
        const f = await questionFixture();
        // A launch in progress has no live ID: starting, or an idle suspension underway.
        f.launches.delete(f.parentTerminalId);

        const { questionId } = f.ask();

        expect(escalatedOf(f, questionId)?.escalatedAt).toBeUndefined();
        expect(f.changes).toHaveLength(1);
    });

    it("treats a question asked after the original launch retired as the user's", async () => {
        const f = await questionFixture();
        f.launches.delete(f.parentTerminalId);
        f.service.interruptTerminal(f.parentTerminalId, false, 'parent-launch');

        const { questionId } = f.ask();

        expect(escalatedOf(f, questionId)?.escalationReason).toBe('parent_gone');
    });

    it('keeps waiting on the Agent when it cannot be proven gone, because the owner delegated the task', async () => {
        const f = await questionFixture();
        // The owner's own task has no delegating Agent whose launch could retire.
        const record = f.database.agentDelegations.get(f.task.id)!;
        f.database.agentDelegations.save({
            ...record,
            callerLaunchId: undefined,
            receipt: { ...record.receipt, callerTerminalId: undefined },
        });

        const { questionId } = f.ask();

        expect(escalatedOf(f, questionId)?.escalatedAt).toBeUndefined();
    });

    it('hands a question to the user at once when an external client delegated the task', async () => {
        const f = await questionFixture();
        // A process outside Caxri has no Terminal or launch to retire, so it can never be proven gone or present.
        const record = f.database.agentDelegations.get(f.task.id)!;
        f.database.agentDelegations.save({
            ...record,
            callerLaunchId: undefined,
            principal: {
                kind: 'delegation-client',
                id: 'external',
                clientId: 'external-client',
                generation: 1,
                projectIds: [f.project.id],
                sessionId: record.receipt.sessionId,
                callerProvider: 'claude',
            },
            receipt: { ...record.receipt, callerTerminalId: undefined },
        });

        const { questionId } = f.ask();

        expect(escalatedOf(f, questionId)).toMatchObject({
            state: 'open',
            escalationReason: 'parent_gone',
        });
        expect(f.changes.map((change) => change.escalated)).toEqual([false, true]);
    });
});
