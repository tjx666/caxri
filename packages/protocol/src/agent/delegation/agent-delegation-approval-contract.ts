import { z } from 'zod';

import { identifierSchema } from '../../domain/identifiers.js';
import type { MethodSpec } from '../../transport/method-spec.js';
import { commandPolicy } from '../../transport/method-spec.js';
import { principalSchema } from '../../transport/principal.js';
import type { DelegationApproval } from './agent-delegation-approval.js';
import {
    delegationApprovalSchema,
    delegationApproveParametersSchema,
    delegationApproveResultSchema,
} from './agent-delegation-approval.js';
import type {
    AgentDelegationAnswer,
    AgentDelegationPullRequest,
    AgentDelegationReceipt,
} from './agent-delegation-contract.js';

const authoritySchema = z.strictObject({
    principal: principalSchema,
    callerTerminalId: identifierSchema.optional(),
});

/**
 * A parent Agent's one-shot decision on a delegated Chat's permission request. Called by the delegating Agent; the
 * Server revalidates lineage, effective permission, takeover, and request state when it arrives.
 */
export const agentDelegationApprovalMethods = {
    'agent.delegation.approve': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: delegationApproveParametersSchema,
        result: delegationApproveResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export const agentDelegationApprovalInternalMethods = {
    'agent.delegation.approveInternal': {
        ...commandPolicy('server', 'control'),
        params: authoritySchema.extend(delegationApproveParametersSchema.shape),
        result: delegationApproveResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * `status` as every caller reads it: the bare receipt, plus the pending approval when the task has one. The receipt
 * itself never carries request content because it also travels in events and the feed.
 */
export type AgentDelegationStatusResult = AgentDelegationReceipt & {
    approval?: DelegationApproval;
};

/**
 * Builds the `status` result from the receipt schema. A factory so this file never reads the contract module at load
 * time (the contract imports this file).
 */
export function delegationStatusResultSchema(
    receipt: z.ZodObject,
): z.ZodType<AgentDelegationStatusResult> {
    return receipt.extend({
        approval: delegationApprovalSchema.optional(),
    }) as unknown as z.ZodType<AgentDelegationStatusResult>;
}

/**
 * `question` means a watched task has an open question for the caller (`questionId`, never its text); it repeats on
 * every wait until the question closes, so pass `ignoreQuestions` to skip it. `approval` means a watched task has a
 * covered permission request the caller may decide (`approval`, with the request content); it ends when the request is
 * decided or escalates to the user, which a wait reports as `blocked`. `settled` and `blocked` rank before `question`,
 * and `question` before `approval`.
 */
export interface AgentDelegationWaitResult {
    receipt: AgentDelegationReceipt;
    answer?: AgentDelegationAnswer;
    pullRequest?: AgentDelegationPullRequest;
    outcome: 'settled' | 'blocked' | 'question' | 'approval' | 'timeout';
    questionId?: string;
    approval?: DelegationApproval;
}

/**
 * Builds the `wait` result schema from the shared result object.
 */
export function delegationWaitResultSchema(
    result: z.ZodObject,
): z.ZodType<AgentDelegationWaitResult> {
    return result
        .extend({
            outcome: z.enum(['settled', 'blocked', 'question', 'approval', 'timeout']),
            questionId: identifierSchema.optional(),
            approval: delegationApprovalSchema.optional(),
        })
        .refine(
            ({ outcome, questionId }) => (outcome === 'question') === (questionId !== undefined),
            { message: 'questionId accompanies exactly the question outcome' },
        )
        .refine(
            ({ outcome, approval }) => {
                const shown = approval as DelegationApproval | undefined;
                return (
                    (outcome === 'approval') ===
                    (shown !== undefined && shown.covered && !shown.escalated)
                );
            },
            { message: 'The approval outcome carries exactly a covered, unescalated approval' },
        ) as unknown as z.ZodType<AgentDelegationWaitResult>;
}
