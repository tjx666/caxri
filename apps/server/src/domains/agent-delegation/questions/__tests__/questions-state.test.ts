import { MAX_QUESTIONS_PER_DELEGATION } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { questionFixture } from './questions.fixture';

const ANSWER = 'Synthetic private answer';

describe('asking a question', () => {
    it('opens one question bound to the asking Agent and announces it without text', async () => {
        const f = await questionFixture();

        const asked = f.ask('Synthetic private question?', { options: ['A', 'B'] });

        expect(asked.outcome).toBe('asked');
        expect(f.database.agentDelegations.questions.get(asked.questionId)).toMatchObject({
            delegationId: f.task.id,
            sessionId: f.task.receipt.sessionId,
            childLaunchId: f.childLaunchId,
            childGeneration: 1,
            state: 'open',
            options: ['A', 'B'],
        });
        expect(f.changes).toEqual([
            {
                sessionId: f.task.receipt.sessionId,
                delegationId: f.task.id,
                questionId: asked.questionId,
                state: 'open',
                escalated: false,
            },
        ]);
    });

    it('leaves the task receipt untouched while a question is pending', async () => {
        const f = await questionFixture();
        const before = f.service.status(f.task.id, f.parent);

        f.ask();

        expect(f.service.status(f.task.id, f.parent)).toEqual(before);
    });

    it('returns the original question for a replayed request ID, whatever its state', async () => {
        const f = await questionFixture();
        const first = f.ask('Synthetic first', { requestId: 'request-1' });

        expect(f.ask('Synthetic retry text', { requestId: 'request-1' })).toEqual(first);
        f.questions.askCancel(f.child(), first.questionId);
        expect(f.ask('Synthetic retry text', { requestId: 'request-1' })).toEqual(first);
        expect(f.database.agentDelegations.questions.countForDelegation(f.task.id)).toBe(1);
    });

    it('reports an open question of a different request and keeps its text', async () => {
        const f = await questionFixture();
        const first = f.ask('Synthetic first question');

        const second = f.ask('Synthetic second question', { requestId: 'request-2' });

        expect(second).toEqual({
            outcome: 'already_open',
            questionId: first.questionId,
            askedAt: first.askedAt,
        });
        expect(f.questions.detail(f.task.id).question?.text).toBe('Synthetic first question');
        expect(f.database.agentDelegations.questions.countForDelegation(f.task.id)).toBe(1);
    });

    it('refuses the question after the lifetime limit with CAPACITY', async () => {
        const f = await questionFixture();
        for (let index = 0; index < MAX_QUESTIONS_PER_DELEGATION; index++) {
            const { questionId } = f.ask(`Synthetic question ${index}`);
            f.questions.answer(f.parent, { delegationId: f.task.id, questionId, text: ANSWER });
        }

        expect(() => f.ask('Synthetic one too many')).toThrow(
            expect.objectContaining({ code: 'CAPACITY' }),
        );
    });

    it('refuses a caller that is not a delegated Agent', async () => {
        const f = await questionFixture();

        expect(() => f.questions.ask(f.owner, { text: 'Synthetic' })).toThrow(
            expect.objectContaining({ code: 'FORBIDDEN' }),
        );
        // The delegating Agent runs no delegated task in its own Terminal.
        expect(() => f.questions.ask(f.parent, { text: 'Synthetic' })).toThrow(
            expect.objectContaining({ code: 'NOT_FOUND' }),
        );
    });
});

describe('the question state machine', () => {
    it('answers an open question once and reports the late answer as already answered', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask();
        const answer = (text: string) =>
            f.questions.answer(f.parent, { delegationId: f.task.id, questionId, text });

        expect(answer(ANSWER)).toEqual({ outcome: 'answered' });
        expect(answer('Synthetic second answer')).toEqual({ outcome: 'already_answered' });
        expect(f.database.agentDelegations.questions.get(questionId)).toMatchObject({
            state: 'answered',
            answeredBy: 'parent',
            answerText: ANSWER,
        });
    });

    it('lets the asking Agent withdraw its question, once', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask();

        expect(f.questions.askCancel(f.child(), questionId)).toEqual({ outcome: 'cancelled' });
        expect(f.questions.askCancel(f.child(), questionId)).toEqual({ outcome: 'already_closed' });
        expect(f.database.agentDelegations.questions.get(questionId)).toMatchObject({
            state: 'cancelled',
            cancelReason: 'child_cancelled',
        });
        expect(
            f.questions.answer(f.parent, { delegationId: f.task.id, questionId, text: ANSWER }),
        ).toEqual({ outcome: 'cancelled' });
    });

    it('does not reopen a closed question when the Agent asks again', async () => {
        const f = await questionFixture();
        const first = f.ask();
        f.questions.askCancel(f.child(), first.questionId);

        const second = f.ask('Synthetic next question');

        expect(second.outcome).toBe('asked');
        expect(second.questionId).not.toBe(first.questionId);
    });

    it.each([
        ['the delegating Agent then the user', 'parent-first'],
        ['the user then the delegating Agent', 'user-first'],
    ] as const)('lets the first answer win when %s answer', async (_label, order) => {
        const f = await questionFixture();
        const { questionId } = f.ask();
        const input = { delegationId: f.task.id, questionId };
        const asParent = () => f.questions.answer(f.parent, { ...input, text: 'Synthetic parent' });
        const asUser = () => f.questions.answerAsUser({ ...input, text: 'Synthetic user' });

        const results = order === 'parent-first' ? [asParent(), asUser()] : [asUser(), asParent()];

        expect(results.map((result) => result.outcome)).toEqual(['answered', 'already_answered']);
        expect(f.database.agentDelegations.questions.get(questionId)).toMatchObject(
            order === 'parent-first'
                ? { answeredBy: 'parent', answerText: 'Synthetic parent' }
                : { answeredBy: 'user', answerText: 'Synthetic user' },
        );
        expect(await f.questions.askWait(f.child(), { questionId, timeoutMs: 0 })).toMatchObject({
            outcome: 'answered',
            answeredBy: order === 'parent-first' ? 'parent' : 'user',
        });
    });
});

describe('who may read and answer a question', () => {
    it('refuses another Terminal, an earlier Endpoint generation, and a restarted launch', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask();
        const wait = (authority: ReturnType<typeof f.child>) =>
            f.questions.askWait(authority, { questionId, timeoutMs: 0 });

        // A sibling or the delegating Agent's own Terminal holds no such delegation.
        await expect(
            wait({ ...f.child(), callerTerminalId: f.parentTerminalId }),
        ).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
        await expect(wait(f.parent)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(wait(f.child(2))).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(() => f.questions.askCancel(f.child(2), questionId)).toThrow(
            expect.objectContaining({ code: 'NOT_FOUND' }),
        );
        f.launches.set(f.task.terminalId, 'restarted-launch');
        await expect(wait(f.child())).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(() => f.questions.askCancel(f.child(), questionId)).toThrow(
            expect.objectContaining({ code: 'NOT_FOUND' }),
        );
        expect(f.questions.detail(f.task.id).question?.questionId).toBe(questionId);
    });

    it('never returns an answer to an Agent restarted while it waited', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask();
        const waiting = f.questions.askWait(f.child(), { questionId, timeoutMs: 5000 });
        const rejected = expect(waiting).rejects.toMatchObject({ code: 'NOT_FOUND' });

        f.launches.set(f.task.terminalId, 'restarted-launch');
        f.questions.answer(f.parent, { delegationId: f.task.id, questionId, text: ANSWER });

        await rejected;
    });

    it('answers only for the Agent that delegated the task, and never for the delegated Agent', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask();
        const input = { delegationId: f.task.id, questionId, text: ANSWER };
        const stranger = {
            ...f.parent,
            callerTerminalId: f.database.createSession(f.project.id, 'codex').terminal!.id,
        };

        expect(() => f.questions.answer(f.child(), input)).toThrow(
            expect.objectContaining({ code: 'FORBIDDEN' }),
        );
        expect(() => f.questions.answer(stranger, input)).toThrow(
            expect.objectContaining({ code: 'FORBIDDEN' }),
        );
        expect(() => f.questions.list(f.child(), f.task.id)).toThrow(
            expect.objectContaining({ code: 'FORBIDDEN' }),
        );
        expect(f.database.agentDelegations.questions.get(questionId)?.state).toBe('open');
    });

    it('refuses an answer that names a question of another delegation', async () => {
        const f = await questionFixture();
        const { questionId } = f.ask();

        expect(() =>
            f.questions.answer(f.parent, { delegationId: 'other', questionId, text: ANSWER }),
        ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
        expect(() =>
            f.questions.answerAsUser({ delegationId: 'other', questionId, text: ANSWER }),
        ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    });

    it('accepts the owner, and Caxri Bot as a later generation of the delegating Agent', async () => {
        const f = await questionFixture();
        const [callerProjectId] = f.parent.principal.projectIds;
        f.database.setAppState('caxriBot', {
            projectId: callerProjectId,
            sessionId: f.callerSessionId,
            terminalId: f.parentTerminalId,
            sessionIds: [],
        });
        const bot = {
            principal: {
                kind: 'agent' as const,
                id: 'bot-next',
                endpointId: 'bot-next',
                generation: 2,
                projectIds: [callerProjectId],
            },
            callerTerminalId: f.parentTerminalId,
        };
        const first = f.ask('Synthetic first');
        f.questions.answer(f.parent, {
            delegationId: f.task.id,
            questionId: first.questionId,
            text: 'one',
        });
        const second = f.ask('Synthetic second');

        expect(f.questions.list(bot, f.task.id).questions).toHaveLength(1);
        expect(
            f.questions.answer(bot, {
                delegationId: f.task.id,
                questionId: second.questionId,
                text: 'two',
            }),
        ).toEqual({ outcome: 'answered' });
        const third = f.ask('Synthetic third');
        expect(f.questions.list(f.owner).questions.map((entry) => entry.questionId)).toEqual([
            third.questionId,
        ]);
        expect(
            f.questions.answer(f.owner, {
                delegationId: f.task.id,
                questionId: third.questionId,
                text: 'three',
            }),
        ).toEqual({ outcome: 'answered' });
    });
});

describe('reading the open questions', () => {
    it('lists text and options to the delegating Agent only, with the escalation flag', async () => {
        const f = await questionFixture();
        const asked = f.ask('Synthetic private question?', { options: ['A', 'B'] });

        expect(f.questions.list(f.parent, f.task.id)).toEqual({
            questions: [
                {
                    delegationId: f.task.id,
                    sessionId: f.task.receipt.sessionId,
                    questionId: asked.questionId,
                    text: 'Synthetic private question?',
                    options: ['A', 'B'],
                    askedAt: asked.askedAt,
                    escalated: false,
                },
            ],
        });
        expect(f.questions.list(f.parent).questions).toHaveLength(1);
    });

    it('reads the detail the Session view shows, and nothing once the question closed', async () => {
        const f = await questionFixture();
        expect(f.questions.detail(f.task.id)).toEqual({});
        const { questionId } = f.ask('Synthetic private question?');

        expect(f.questions.detail(f.task.id).question).toMatchObject({
            questionId,
            text: 'Synthetic private question?',
            escalated: false,
        });
        f.questions.answerAsUser({ delegationId: f.task.id, questionId, text: ANSWER });
        expect(f.questions.detail(f.task.id)).toEqual({});
        expect(() => f.questions.detail('missing')).toThrow(
            expect.objectContaining({ code: 'NOT_FOUND' }),
        );
    });
});
