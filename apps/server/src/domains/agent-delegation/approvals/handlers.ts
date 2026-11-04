import { coreRouted } from '../../core-routed';
import type { DomainHandlers } from '../../domain-services';
import type { DelegationApprovals } from './service';

export type ApprovalMethod = 'agent.delegation.approve' | 'agent.delegation.approveInternal';

/**
 * The handler map for a delegating Agent's decision on its delegated Chat's permission requests. The public method is
 * routed by Server Core to its Internal twin, which carries the caller's authority.
 */
export function createApprovalHandlers(
    approvals: DelegationApprovals,
): Pick<DomainHandlers, ApprovalMethod> {
    return {
        'agent.delegation.approve': () => coreRouted('agent.delegation.approve'),
        'agent.delegation.approveInternal': ({
            delegationId,
            requestId,
            decision,
            revision,
            ...authority
        }) => approvals.approve(authority, { delegationId, requestId, decision, revision }),
    };
}
