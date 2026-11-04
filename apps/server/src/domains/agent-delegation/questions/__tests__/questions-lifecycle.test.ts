import { parseServerOperationResult } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { createDelegationHandlers } from '../../handlers';
import { MAX_QUESTION_WAITERS } from '../wait';
import { questionFixture } from './questions.fixture';

type Fixture = Awaited<ReturnType<typeof questionFixture>>;

const stateOf = (f: Awaited<ReturnType<typeof questionFixture>>, questionId: string) =>
    f.database.agentDelegations.questions.get(questionId);

describe('a person typing into the asking Agent', () => {
    const surfaces: Array<[string, NonNullable<Parameters<typeof questionFixture>[0]>]> = [
        ['an Agent Chat', { isChatTerminal: () => true }],
        ['a Terminal (PTY)', { isChatTerminal: () => false, hasLifecycleHooks: () => true }],
    ];

    it.each(surfaces)('cancels the question as taken over for %s', async (_surface, overrides) => {
        const f = await questionFixture(overrides);
        const { questionId } = f.ask();

        f.service.interruptTerminal(f.task.terminalId, true);

        expect(stateOf(f, questionId)).toMatchObject({
            state: 'cancelled',
            cancelReason: 'taken_over',
        });
        expect(f.changes.at(-1)).toMatchObject({ questionId, state: 'cancelled' });
        await expect(f.questions.askWait(f.child(), { questionId, timeoutMs: 0 })).resolves.toEqual(
            { outcome: 'cancelled', cancelReason: 'taken_over' },
        );
        expect(f.service.status(f.task.id, f.parent).status).toBe('human_intervened');
    });

    it('treats input that answers a startup prompt as no takeover', async () => {
        const f = await questionFixture({}, { isStarted: false });
        const { questionId } = f.ask();

        f.service.interruptTerminal(f.task.terminalId, true);

        expect(stateOf(f, questionId)?.state).toBe('open');
        expect(f.service.status(f.task.id, f.parent).status).toBe('awaiting_ready');
    });

    it('leaves a question of another Terminal alone', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask();

        f.service.interruptTerminal(f.parentTerminalId, true);

        expect(stateOf(f, questionId)?.state).toBe('open');
    });
});

describe('a question that can no longer be answered', () => {
    it('is cancelled as host reset when Server Core restarts, without an event', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask();
        const events = f.changes.length;

        f.service.initialize();

        expect(stateOf(f, questionId)).toMatchObject({
            state: 'cancelled',
            cancelReason: 'host_reset',
        });
        expect(f.changes).toHaveLength(events);
        expect(f.entries('agent_delegation.question_cancelled')).toEqual([
            expect.objectContaining({ questionId, cancelReason: 'host_reset' }),
        ]);
    });

    const endings: Array<[string, (f: Fixture) => void | Promise<void>]> = [
        [
            'settles',
            async (f) => {
                await f.finish(f.task, 'Summary: done.');
            },
        ],
        [
            'is stopped',
            (f) => {
                f.service.stop(f.task.id, f.parent);
            },
        ],
        [
            'fails because its launch retired',
            (f) => {
                f.service.interruptTerminal(f.task.terminalId, false, f.childLaunchId);
            },
        ],
    ];

    it.each(endings)('is cancelled as task ended when the task %s', async (_label, end) => {
        const f = await questionFixture();
        const { questionId } = f.ask();

        await end(f);

        expect(stateOf(f, questionId)).toMatchObject({
            state: 'cancelled',
            cancelReason: 'task_ended',
        });
        expect(f.changes.at(-1)).toMatchObject({ questionId, state: 'cancelled' });
        expect(f.questions.detail(f.task.id)).toEqual({});
    });

    it('lets the asking Agent still read why its question closed, after the task ended', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask();
        f.service.stop(f.task.id, f.parent);

        await expect(f.questions.askWait(f.child(), { questionId, timeoutMs: 0 })).resolves.toEqual(
            { outcome: 'cancelled', cancelReason: 'task_ended' },
        );
    });
});

describe('waiting for an answer', () => {
    it('returns the answer when it arrives during the wait', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask();
        const waiting = f.questions.askWait(f.child(), { questionId, timeoutMs: 5000 });

        setTimeout(() => {
            f.questions.answerAsUser({ delegationId: f.task.id, questionId, text: 'Synthetic' });
        }, 50);

        await expect(waiting).resolves.toEqual({
            outcome: 'answered',
            answer: 'Synthetic',
            answeredBy: 'user',
        });
    });

    it('times out with the question still open', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask();

        await expect(
            f.questions.askWait(f.child(), { questionId, timeoutMs: 30 }),
        ).resolves.toEqual({ outcome: 'timeout' });
        expect(stateOf(f, questionId)?.state).toBe('open');
    });

    it('stops waiting when the caller disconnects and frees its waiter slot', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask();
        const aborts = Array.from({ length: MAX_QUESTION_WAITERS }, () => new AbortController());
        const waiters = aborts.map((controller) =>
            f.questions.askWait(f.child(), { questionId, timeoutMs: 5000 }, controller.signal),
        );
        const settled = waiters.map((waiter) =>
            expect(waiter).rejects.toMatchObject({ name: 'AbortError' }),
        );

        await expect(
            f.questions.askWait(f.child(), { questionId, timeoutMs: 5000 }),
        ).rejects.toMatchObject({ code: 'CAPACITY' });
        for (const controller of aborts) controller.abort();
        await Promise.all(settled);

        await expect(f.questions.askWait(f.child(), { questionId, timeoutMs: 0 })).resolves.toEqual(
            { outcome: 'timeout' },
        );
    });

    it('ends the wait when the service closes', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask();
        const waiting = f.questions.askWait(f.child(), { questionId, timeoutMs: 5000 });
        const rejected = expect(waiting).rejects.toMatchObject({ code: 'UNAVAILABLE' });

        f.service.close();

        await rejected;
    });
});

describe('a delegation wait that meets a question', () => {
    it('returns the question outcome with its ID and no text, on every call until it closes', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask('Synthetic private question?');

        const results = [
            await f.service.wait([f.task.id], f.parent, 5000),
            await f.service.wait([f.task.id], f.parent, 5000),
        ];
        for (const result of results) {
            expect(result).toMatchObject({ outcome: 'question', questionId });
            expect(JSON.stringify(result)).not.toContain('Synthetic private question?');
        }
        f.questions.answer(f.parent, { delegationId: f.task.id, questionId, text: 'Synthetic' });
        expect((await f.service.wait([f.task.id], f.parent, 20)).outcome).toBe('timeout');
    });

    it('skips the question when the caller ignores questions', async () => {
        const f = await questionFixture();
        f.ask();

        const result = await f.service.wait([f.task.id], f.parent, 20, undefined, true);

        expect(result).toMatchObject({ outcome: 'timeout' });
        expect(result).not.toHaveProperty('questionId', expect.any(String));
    });

    it('reports a settled task before any question, and a question has no answer to claim', async () => {
        const f = await questionFixture();
        f.ask();
        await f.finish(f.task, 'Summary: done.');

        const result = await f.service.wait([f.task.id], f.parent, 5000);

        expect(result.outcome).toBe('settled');
        expect(result).not.toHaveProperty('questionId', expect.any(String));
    });

    it('passes the result contract through the handler', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask();
        const handlers = createDelegationHandlers(f.service, f.database);

        const result = parseServerOperationResult(
            'agent.delegation.waitInternal',
            await handlers['agent.delegation.waitInternal']({
                ...f.parent,
                delegationId: f.task.id,
                timeoutMs: 1000,
            }),
        );

        expect(result).toMatchObject({ outcome: 'question', questionId });
    });
});

describe('the Delegated Sessions feed', () => {
    it('shows the open question and who it waits on, without its text', async () => {
        const f = await questionFixture();
        const [before] = await f.sessions([f.callerSessionId]);
        expect(before).not.toHaveProperty('question');
        const { questionId, askedAt } = f.ask('Synthetic private question?');

        const [session] = await f.sessions([f.callerSessionId]);
        const [status] = await f.statuses([f.task.id]);

        for (const entry of [session, status]) {
            expect(entry).toMatchObject({
                question: { questionId, askedAt, escalated: false },
                waitingOn: 'parent',
            });
            expect(JSON.stringify(entry)).not.toContain('Synthetic private question?');
        }
        f.questions.answerAsUser({ delegationId: f.task.id, questionId, text: 'Synthetic' });
        const [answered] = await f.sessions([f.callerSessionId]);
        expect(answered).not.toHaveProperty('question');
        expect(answered).not.toHaveProperty('waitingOn');
    });
});

describe('the handlers', () => {
    it('answers and reads the owner-only methods through their result contracts', async () => {
        const f = await questionFixture();
        const handlers = createDelegationHandlers(f.service, f.database);
        const { questionId } = f.ask('Synthetic private question?', { options: ['A'] });

        const detail = parseServerOperationResult(
            'agent.delegation.questionDetail',
            await handlers['agent.delegation.questionDetail']({ delegationId: f.task.id }),
        );
        const answered = parseServerOperationResult(
            'agent.delegation.questionAnswer',
            await handlers['agent.delegation.questionAnswer']({
                delegationId: f.task.id,
                questionId,
                text: 'Synthetic',
            }),
        );

        expect(detail.question).toMatchObject({ questionId, options: ['A'] });
        expect(answered).toEqual({ outcome: 'answered' });
    });

    it('serves every Agent method through the Internal twin carrying the caller authority', async () => {
        const f = await questionFixture();
        const handlers = createDelegationHandlers(f.service, f.database);

        const asked = await handlers['agent.delegation.askInternal']({
            ...f.child(),
            text: 'Synthetic private question?',
        });
        const listed = await handlers['agent.delegation.questionsInternal']({ ...f.parent });
        const answered = await handlers['agent.delegation.answerInternal']({
            ...f.parent,
            delegationId: f.task.id,
            questionId: asked.questionId,
            text: 'Synthetic',
        });
        const waited = await handlers['agent.delegation.askWaitInternal']({
            ...f.child(),
            questionId: asked.questionId,
            timeoutMs: 0,
        });
        const cancelled = await handlers['agent.delegation.askCancelInternal']({
            ...f.child(),
            questionId: asked.questionId,
        });

        expect(asked.outcome).toBe('asked');
        expect(listed.questions).toHaveLength(1);
        expect(answered).toEqual({ outcome: 'answered' });
        expect(waited).toMatchObject({ outcome: 'answered', answer: 'Synthetic' });
        expect(cancelled).toEqual({ outcome: 'already_closed' });
    });
});

describe('what the Server records about a question', () => {
    it('keeps question and answer text out of events and logs across ask, escalate, and answer', async () => {
        const f = await questionFixture();
        f.launches.set(f.parentTerminalId, 'resumed-launch');
        const { questionId } = f.ask('Synthetic private question?', {
            options: ['Synthetic option'],
        });
        f.questions.answer(f.parent, {
            delegationId: f.task.id,
            questionId,
            text: 'Synthetic private answer',
        });
        const second = f.ask('Synthetic second private question?');
        f.questions.askCancel(f.child(), second.questionId);
        const observed = f.observed();

        expect(observed).toContain(questionId);
        for (const secret of [
            'Synthetic private question?',
            'Synthetic option',
            'Synthetic private answer',
            'Synthetic second private question?',
        ])
            expect(observed).not.toContain(secret);
        expect(f.entries('agent_delegation.question_asked')).toEqual([
            { delegationId: f.task.id, questionId, optionCount: 1 },
            expect.objectContaining({ questionId: second.questionId, optionCount: 0 }),
        ]);
        expect(f.entries('agent_delegation.question_answered')).toEqual([
            expect.objectContaining({ questionId, answeredBy: 'parent' }),
        ]);
        expect(f.entries('agent_delegation.question_cancelled')).toEqual([
            expect.objectContaining({
                questionId: second.questionId,
                cancelReason: 'child_cancelled',
            }),
        ]);
        expect(f.entries('agent_delegation.question_escalated')).toEqual([
            expect.objectContaining({ questionId, escalationReason: 'parent_gone' }),
            expect.objectContaining({ questionId: second.questionId }),
        ]);
        expect(Object.keys(f.changes[0]).toSorted((a, b) => a.localeCompare(b))).toEqual([
            'delegationId',
            'escalated',
            'questionId',
            'sessionId',
            'state',
        ]);
    });
});
