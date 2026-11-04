import { z } from 'zod';

import { identifierSchema } from '../../domain/identifiers.js';
import type { MethodSpec } from '../../transport/method-spec.js';
import { commandPolicy, ownerOnlyCommandPolicy } from '../../transport/method-spec.js';
import { principalSchema } from '../../transport/principal.js';
import type {
    DelegationQuestionAnswerResult,
    DelegationQuestionDetailResult,
} from './agent-delegation-question.js';
import {
    delegationQuestionAnswerParametersSchema,
    delegationQuestionAnswerResultSchema,
    delegationQuestionAskParametersSchema,
    delegationQuestionAskResultSchema,
    delegationQuestionCancelParametersSchema,
    delegationQuestionCancelResultSchema,
    delegationQuestionDetailParametersSchema,
    delegationQuestionDetailResultSchema,
    delegationQuestionsParametersSchema,
    delegationQuestionsResultSchema,
    delegationQuestionWaitParametersSchema,
    delegationQuestionWaitResultSchema,
} from './agent-delegation-question.js';

const authoritySchema = z.strictObject({
    principal: principalSchema,
    callerTerminalId: identifierSchema.optional(),
});

/**
 * The questions a delegated Agent asks the Agent that delegated it. `ask`, `askWait`, and `askCancel` are called by the
 * asking (child) Agent; `questions` and `answer` by the delegating (parent) Agent. Question text appears only in a
 * reply, so nothing here is logged or journaled with it.
 */
export const agentDelegationQuestionMethods = {
    'agent.delegation.ask': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: delegationQuestionAskParametersSchema,
        result: delegationQuestionAskResultSchema,
    },
    'agent.delegation.askWait': {
        ...commandPolicy('server', 'read', ['agents.delegate']),
        params: delegationQuestionWaitParametersSchema,
        result: delegationQuestionWaitResultSchema,
    },
    'agent.delegation.askCancel': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: delegationQuestionCancelParametersSchema,
        result: delegationQuestionCancelResultSchema,
    },
    'agent.delegation.questions': {
        ...commandPolicy('server', 'read', ['agents.delegate']),
        params: delegationQuestionsParametersSchema,
        result: delegationQuestionsResultSchema,
    },
    'agent.delegation.answer': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: delegationQuestionAnswerParametersSchema,
        result: delegationQuestionAnswerResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export const agentDelegationQuestionInternalMethods = {
    'agent.delegation.askInternal': {
        ...commandPolicy('server', 'control'),
        params: authoritySchema.extend(delegationQuestionAskParametersSchema.shape),
        result: delegationQuestionAskResultSchema,
    },
    'agent.delegation.askWaitInternal': {
        ...commandPolicy('server', 'read'),
        params: authoritySchema.extend(delegationQuestionWaitParametersSchema.shape),
        result: delegationQuestionWaitResultSchema,
    },
    'agent.delegation.askCancelInternal': {
        ...commandPolicy('server', 'control'),
        params: authoritySchema.extend(delegationQuestionCancelParametersSchema.shape),
        result: delegationQuestionCancelResultSchema,
    },
    'agent.delegation.questionsInternal': {
        ...commandPolicy('server', 'read'),
        params: authoritySchema.extend(delegationQuestionsParametersSchema.shape),
        result: delegationQuestionsResultSchema,
    },
    'agent.delegation.answerInternal': {
        ...commandPolicy('server', 'control'),
        params: authoritySchema.extend(delegationQuestionAnswerParametersSchema.shape),
        result: delegationQuestionAnswerResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * `agent.delegation.questionAnswer` as a named type. Annotated rather than inferred, like `CancelScheduledRetrySpec`:
 * the method registry's inferred type is at the compiler's serialization limit. Exported only so the registry's
 * declaration can name it.
 *
 * @public
 */
export interface QuestionAnswerSpec extends ReturnType<
    typeof ownerOnlyCommandPolicy<'server', 'control'>
> {
    params: z.ZodType<{ delegationId: string; questionId: string; text: string }>;
    result: z.ZodType<DelegationQuestionAnswerResult>;
}

/**
 * `agent.delegation.questionDetail` as a named type; see `QuestionAnswerSpec`.
 *
 * @public
 */
export interface QuestionDetailSpec extends ReturnType<
    typeof ownerOnlyCommandPolicy<'server', 'read'>
> {
    params: z.ZodType<{ delegationId: string }>;
    result: z.ZodType<DelegationQuestionDetailResult>;
}

/**
 * Owner-only: the user answers a delegated Session's question from the Workbench. An Agent answers through
 * `agent.delegation.answer`; the Bot and Benchmark windows and every Mobile role are refused. No Internal twin: the
 * handler is called directly, like `retry`.
 */
const questionAnswer: QuestionAnswerSpec = {
    ...ownerOnlyCommandPolicy('server', 'control'),
    params: delegationQuestionAnswerParametersSchema,
    result: delegationQuestionAnswerResultSchema,
};

/**
 * Owner-only read of the open question's text for the Session view, so the Renderer never calls the agent-callable
 * `agent.delegation.questions`.
 */
const questionDetail: QuestionDetailSpec = {
    ...ownerOnlyCommandPolicy('server', 'read'),
    params: delegationQuestionDetailParametersSchema,
    result: delegationQuestionDetailResultSchema,
};

export const agentDelegationQuestionOwnerMethods = {
    'agent.delegation.questionAnswer': questionAnswer,
    'agent.delegation.questionDetail': questionDetail,
} as const satisfies Record<string, MethodSpec>;
