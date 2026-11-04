import type { DelegationApprovals } from '../approvals/service';
import type { DelegationHandBacks } from '../handback/service';
import type { DelegationQuestions } from '../questions/service';
import type { AgentDelegationServiceOptions } from '../service-options';
import type { SettlementNoticeSources } from './contract';
import type { SettlementNotices } from './service';

/**
 * What the notices read at send time from the question and approval services, which the delegation service builds after
 * the notices. Read lazily for that reason.
 */
export function noticeSources(
    services: () => {
        approvals: DelegationApprovals;
        handBacks: DelegationHandBacks;
        questions: DelegationQuestions;
    },
): SettlementNoticeSources {
    return {
        isApprovalDecidable: (delegationId, requestId) => {
            const approval = services().approvals.viewFor(delegationId);
            return (
                approval?.requestId === requestId &&
                approval.covered === true &&
                !approval.escalated
            );
        },
        isQuestionWithParent: (delegationId, questionId) =>
            services().questions.isWithParent(delegationId, questionId),
        isHandBackPending: (grantId) => services().handBacks.isPending(grantId),
    };
}

/**
 * The options the question and approval services get: the same callbacks, which also tell the settlement notices that a
 * question was asked or a permission request now waits on the delegating Agent. The notices read both again at send
 * time, so a hook only has to say that something may be owed.
 *
 * The approval environment is a view over the original, not a copy: its other members are read live, and a composition
 * root may still replace one after the service exists.
 */
export function withNoticeHooks(
    options: AgentDelegationServiceOptions,
    notices: SettlementNotices,
): AgentDelegationServiceOptions {
    const { approvals } = options;
    return {
        ...options,
        onQuestionChanged: (change) => {
            options.onQuestionChanged?.(change);
            notices.questionChanged(change);
        },
        ...(approvals && {
            approvals: Object.create(approvals, {
                onChanged: {
                    value: (change: Parameters<typeof approvals.onChanged>[0]) => {
                        approvals.onChanged(change);
                        notices.approvalChanged(change);
                    },
                },
            }) as typeof approvals,
        }),
    };
}
