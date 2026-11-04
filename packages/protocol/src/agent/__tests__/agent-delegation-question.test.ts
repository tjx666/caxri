import { describe, expect, it } from 'vitest';

import { isTransientServerEvent } from '../../transport/event-journal';
import type { AgentDelegationWaitResult } from '../delegation/agent-delegation-contract';
import { agentDelegationMethods } from '../delegation/agent-delegation-contract';
import type {
    DelegationQuestionChanged,
    DelegationQuestionDetail,
    DelegationQuestionEntry,
    DelegationWaitingOn,
} from '../delegation/agent-delegation-question';
import {
    delegationQuestionAnswerParametersSchema,
    delegationQuestionAskParametersSchema,
    delegationQuestionChangedSchema,
    delegationQuestionDetailResultSchema,
    delegationQuestionsResultSchema,
    delegationQuestionWaitParametersSchema,
    delegationQuestionWaitResultSchema,
    delegationWaitingOnSchema,
    MAX_ANSWER_TEXT_CHARS,
    MAX_LISTED_QUESTIONS,
    MAX_QUESTION_OPTION_CHARS,
    MAX_QUESTION_OPTIONS,
    MAX_QUESTION_TEXT_CHARS,
    MAX_QUESTION_WAIT_TIMEOUT_MS,
    MAX_QUESTIONS_PER_DELEGATION,
    QUESTION_ESCALATION_GRACE_MS,
} from '../delegation/agent-delegation-question';
import {
    agentDelegationQuestionInternalMethods,
    agentDelegationQuestionMethods,
    agentDelegationQuestionOwnerMethods,
} from '../delegation/agent-delegation-question-contract';

describe('delegation question parameters', () => {
    it('bounds the question text, the options, and the answer', () => {
        const ask = delegationQuestionAskParametersSchema;

        expect(ask.safeParse({ text: 'x'.repeat(MAX_QUESTION_TEXT_CHARS) }).success).toBe(true);
        expect(ask.safeParse({ text: 'x'.repeat(MAX_QUESTION_TEXT_CHARS + 1) }).success).toBe(
            false,
        );
        expect(ask.safeParse({ text: ' '.repeat(3) }).success).toBe(false);
        expect(
            ask.safeParse({
                text: 'Which one?',
                options: Array.from({ length: MAX_QUESTION_OPTIONS }, (_, index) => `o${index}`),
            }).success,
        ).toBe(true);
        expect(
            ask.safeParse({
                text: 'Which one?',
                options: Array.from(
                    { length: MAX_QUESTION_OPTIONS + 1 },
                    (_, index) => `o${index}`,
                ),
            }).success,
        ).toBe(false);
        expect(
            ask.safeParse({
                text: 'Which one?',
                options: ['y'.repeat(MAX_QUESTION_OPTION_CHARS + 1)],
            }).success,
        ).toBe(false);
        expect(ask.safeParse({ text: 'Which one?', options: [''] }).success).toBe(false);
        const answer = delegationQuestionAnswerParametersSchema;
        const ids = { delegationId: 'd', questionId: 'q' };
        expect(answer.safeParse({ ...ids, text: 'a'.repeat(MAX_ANSWER_TEXT_CHARS) }).success).toBe(
            true,
        );
        expect(
            answer.safeParse({ ...ids, text: 'a'.repeat(MAX_ANSWER_TEXT_CHARS + 1) }).success,
        ).toBe(false);
    });

    it('rejects unknown keys on every parameter object', () => {
        expect(
            delegationQuestionAskParametersSchema.safeParse({ text: 'q', extra: 1 }).success,
        ).toBe(false);
        expect(
            delegationQuestionWaitParametersSchema.safeParse({ questionId: 'q', extra: 1 }).success,
        ).toBe(false);
    });

    it('defaults and bounds the question wait timeout', () => {
        const parse = (value: unknown) => delegationQuestionWaitParametersSchema.safeParse(value);

        expect(parse({ questionId: 'q' }).data?.timeoutMs).toBe(30_000);
        expect(parse({ questionId: 'q', timeoutMs: MAX_QUESTION_WAIT_TIMEOUT_MS }).success).toBe(
            true,
        );
        expect(
            parse({ questionId: 'q', timeoutMs: MAX_QUESTION_WAIT_TIMEOUT_MS + 1 }).success,
        ).toBe(false);
    });
});

describe('delegation question methods', () => {
    it('gives every public method an Internal twin that adds the authority', () => {
        for (const name of Object.keys(agentDelegationQuestionMethods)) {
            const twin =
                agentDelegationQuestionInternalMethods[
                    `${name}Internal` as keyof typeof agentDelegationQuestionInternalMethods
                ];
            expect(Object.keys(twin.params.shape)).toContain('principal');
        }
    });

    it('keeps the answer and the detail read owner-only with no Internal twin', () => {
        for (const [name, spec] of Object.entries(agentDelegationQuestionOwnerMethods)) {
            expect(spec).toMatchObject({ principal: 'owner' });
            expect(Object.keys(agentDelegationQuestionInternalMethods)).not.toContain(
                `${name}Internal`,
            );
        }
        for (const spec of Object.values(agentDelegationQuestionMethods))
            expect(spec).not.toHaveProperty('principal', 'owner');
    });

    it('reads the answer and the detail as an owner read and a control', () => {
        expect(
            agentDelegationQuestionOwnerMethods['agent.delegation.questionDetail'],
        ).toMatchObject({ effect: 'read' });
        expect(
            agentDelegationQuestionOwnerMethods['agent.delegation.questionAnswer'],
        ).toMatchObject({ effect: 'control' });
    });
});

describe('delegation question bounds', () => {
    it('pins the per-delegation cap and the escalation grace', () => {
        expect(MAX_QUESTIONS_PER_DELEGATION).toBe(10);
        expect(QUESTION_ESCALATION_GRACE_MS).toBe(600_000);
    });
});

describe('delegation question results', () => {
    const entry: DelegationQuestionEntry = {
        delegationId: 'd',
        sessionId: 's',
        questionId: 'q',
        text: 'Which one?',
        options: ['A', 'B'],
        askedAt: 1,
        escalated: false,
    };

    it('lists at most the bounded number of open questions', () => {
        const list = (count: number) =>
            delegationQuestionsResultSchema.safeParse({
                questions: Array.from({ length: count }, () => entry),
            }).success;

        expect(list(MAX_LISTED_QUESTIONS)).toBe(true);
        expect(list(MAX_LISTED_QUESTIONS + 1)).toBe(false);
    });

    it('returns the open question of one delegation or none', () => {
        const detail: DelegationQuestionDetail = {
            questionId: 'q',
            text: 'Which one?',
            options: ['A', 'B'],
            askedAt: 1,
            escalated: false,
        };

        expect(delegationQuestionDetailResultSchema.safeParse({ question: detail }).success).toBe(
            true,
        );
        expect(delegationQuestionDetailResultSchema.safeParse({}).success).toBe(true);
        expect(
            delegationQuestionDetailResultSchema.safeParse({ question: { ...detail, extra: 1 } })
                .success,
        ).toBe(false);
    });

    it('names who an open question waits on', () => {
        const waiting: DelegationWaitingOn[] = ['parent', 'user'];

        expect(delegationWaitingOnSchema.options).toEqual(waiting);
    });

    it('carries an answer only with the answered outcome shape and no unknown keys', () => {
        const result = delegationQuestionWaitResultSchema;

        expect(
            result.safeParse({ outcome: 'answered', answer: 'Use A', answeredBy: 'user' }).success,
        ).toBe(true);
        expect(result.safeParse({ outcome: 'cancelled', cancelReason: 'taken_over' }).success).toBe(
            true,
        );
        expect(result.safeParse({ outcome: 'timeout' }).success).toBe(true);
        expect(result.safeParse({ outcome: 'cancelled', cancelReason: 'other' }).success).toBe(
            false,
        );
        expect(result.safeParse({ outcome: 'timeout', extra: 1 }).success).toBe(false);
    });
});

describe('agent.delegation.wait with questions', () => {
    const { params, result } = agentDelegationMethods['agent.delegation.wait'];
    const receipt = {
        delegationId: 'd',
        projectId: 'p',
        sessionId: 's',
        provider: 'claude',
        status: 'running',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
    };

    it('accepts ignoreQuestions', () => {
        expect(params.safeParse({ delegationId: 'd', ignoreQuestions: true }).success).toBe(true);
        expect(params.safeParse({ delegationId: 'd', ignoreQuestions: 'yes' }).success).toBe(false);
    });

    it('returns questionId with the question outcome only, and never text', () => {
        const parsed: AgentDelegationWaitResult | undefined = result.safeParse({
            receipt,
            outcome: 'question',
            questionId: 'q',
        }).data;

        expect(parsed?.questionId).toBe('q');
        expect(result.safeParse({ receipt, outcome: 'question', questionId: 'q' }).success).toBe(
            true,
        );
        expect(result.safeParse({ receipt, outcome: 'question' }).success).toBe(false);
        expect(result.safeParse({ receipt, outcome: 'timeout', questionId: 'q' }).success).toBe(
            false,
        );
        expect(
            result.safeParse({ receipt, outcome: 'question', questionId: 'q', text: 'secret' })
                .success,
        ).toBe(false);
        expect(result.safeParse({ receipt, outcome: 'settled' }).success).toBe(true);
    });

    it('shares the schema with the Internal twin', async () => {
        const { agentDelegationInternalMethods } =
            await import('../delegation/agent-delegation-contract');

        expect(agentDelegationInternalMethods['agent.delegation.waitInternal'].result).toBe(result);
    });
});

describe('agent.delegation.questionChanged', () => {
    const payload = {
        sessionId: 's',
        delegationId: 'd',
        questionId: 'q',
        state: 'open',
        escalated: false,
    } satisfies DelegationQuestionChanged;

    it('carries identifiers and closed values only', () => {
        expect(delegationQuestionChangedSchema.safeParse(payload).success).toBe(true);
        expect(
            delegationQuestionChangedSchema.safeParse({ ...payload, text: 'What is the plan?' })
                .success,
        ).toBe(false);
        expect(
            delegationQuestionChangedSchema.safeParse({ ...payload, state: 'lost' }).success,
        ).toBe(false);
        expect(
            Object.keys(delegationQuestionChangedSchema.shape).toSorted((a, b) =>
                a.localeCompare(b),
            ),
        ).toEqual(['delegationId', 'escalated', 'questionId', 'sessionId', 'state']);
    });

    it('is journaled as transient, so a replay never holds it', () => {
        expect(
            isTransientServerEvent({ event: 'agent.delegation.questionChanged', payload } as never),
        ).toBe(true);
    });
});
