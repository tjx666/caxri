import { describe, expect, it } from 'vitest';

import { isTransientServerEvent } from '../../transport/event-journal';
import type { DelegationApproval } from '../delegation/agent-delegation-approval';
import {
    APPROVAL_ESCALATION_GRACE_MS,
    approvalCoverageReasonSchema,
    delegationApprovalChangedSchema,
    delegationApprovalSchema,
    delegationApprovalSummarySchema,
    delegationApproveParametersSchema,
    delegationApproveResultSchema,
} from '../delegation/agent-delegation-approval';
import { agentDelegationApprovalMethods } from '../delegation/agent-delegation-approval-contract';
import { agentDelegationMethods } from '../delegation/agent-delegation-contract';
import { agentDelegationSettingsSchema } from '../delegation/agent-delegation-settings';

const receipt = {
    delegationId: 'd',
    projectId: 'p',
    sessionId: 's',
    provider: 'claude',
    status: 'blocked',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
};

const approval: DelegationApproval = {
    requestId: 'r',
    kind: 'command',
    covered: true,
    coverageReason: 'covered',
    escalated: false,
    requestedAt: 1,
    revision: 'rev1',
    command: 'ls',
    cwd: '/repo',
};

describe('agent.delegation.approve', () => {
    const { params, result } = agentDelegationApprovalMethods['agent.delegation.approve'];

    it('takes a delegation, a request, its revision, and one of two decisions, and nothing else', () => {
        const base = { delegationId: 'd', requestId: 'r', revision: 'rev1' };
        expect(params.safeParse({ ...base, decision: 'accept' }).success).toBe(true);
        expect(params.safeParse({ ...base, decision: 'decline' }).success).toBe(true);
        for (const bad of [
            { ...base, decision: 'acceptForSession' },
            { ...base, decision: 'acceptAlways' },
            { ...base, decision: 'cancel' },
            { ...base },
            { delegationId: 'd', requestId: 'r', decision: 'accept' },
            { ...base, revision: '', decision: 'accept' },
            { delegationId: 'd', revision: 'rev1', decision: 'accept' },
            { requestId: 'r', revision: 'rev1', decision: 'accept' },
            { ...base, decision: 'accept', command: 'ls' },
            { ...base, requestId: '', decision: 'accept' },
        ])
            expect(params.safeParse(bad).success).toBe(false);
    });

    it('answers with a closed outcome and no request content', () => {
        expect(result.safeParse({ outcome: 'approved' }).success).toBe(true);
        expect(result.safeParse({ outcome: 'declined' }).success).toBe(true);
        expect(result.safeParse({ outcome: 'maybe' }).success).toBe(false);
        expect(result.safeParse({ outcome: 'approved', command: 'ls' }).success).toBe(false);
        expect(delegationApproveResultSchema).toBe(result);
        expect(delegationApproveParametersSchema).toBe(params);
    });

    it('is a server-owned control method for the delegating Agent', () => {
        expect(agentDelegationApprovalMethods['agent.delegation.approve']).toMatchObject({
            owner: 'server',
            effect: 'control',
        });
    });
});

describe('agent.delegation.wait with approvals', () => {
    const { result } = agentDelegationMethods['agent.delegation.wait'];

    it('carries an approval with the approval outcome only when it is covered and unescalated', () => {
        expect(result.safeParse({ receipt, outcome: 'approval', approval }).success).toBe(true);
        expect(result.safeParse({ receipt, outcome: 'approval' }).success).toBe(false);
        expect(
            result.safeParse({
                receipt,
                outcome: 'approval',
                approval: { ...approval, covered: false },
            }).success,
        ).toBe(false);
        expect(
            result.safeParse({
                receipt,
                outcome: 'approval',
                approval: { ...approval, escalated: true },
            }).success,
        ).toBe(false);
    });

    it('lets a blocked task carry the approval the user now owns, but not a decidable one', () => {
        expect(
            result.safeParse({
                receipt,
                outcome: 'blocked',
                approval: { ...approval, escalated: true },
            }).success,
        ).toBe(true);
        expect(result.safeParse({ receipt, outcome: 'blocked', approval }).success).toBe(false);
        expect(result.safeParse({ receipt, outcome: 'timeout', approval }).success).toBe(false);
    });

    it('keeps a question and an approval apart', () => {
        expect(
            result.safeParse({ receipt, outcome: 'question', questionId: 'q', approval }).success,
        ).toBe(false);
        expect(
            result.safeParse({ receipt, outcome: 'approval', questionId: 'q', approval }).success,
        ).toBe(false);
    });
});

describe('agent.delegation.status', () => {
    const { result } = agentDelegationMethods['agent.delegation.status'];

    it('adds the approval to the bare receipt and rejects other fields', () => {
        expect(result.safeParse(receipt).success).toBe(true);
        expect(result.safeParse({ ...receipt, approval }).success).toBe(true);
        expect(result.safeParse({ ...receipt, approval: { ...approval, extra: 1 } }).success).toBe(
            false,
        );
    });
});

describe('DelegationApproval', () => {
    it('bounds its content to the request projection caps', () => {
        expect(
            delegationApprovalSchema.safeParse({ ...approval, command: 'x'.repeat(4096) }).success,
        ).toBe(true);
        expect(
            delegationApprovalSchema.safeParse({ ...approval, command: 'x'.repeat(4097) }).success,
        ).toBe(false);
        expect(
            delegationApprovalSchema.safeParse({
                ...approval,
                paths: Array.from({ length: 21 }, (_, index) => `/r/${index}`),
            }).success,
        ).toBe(false);
    });

    it('has a feed summary without any content', () => {
        const summary: Record<string, unknown> = { ...approval };
        delete summary.command;
        delete summary.cwd;
        delete summary.revision;

        expect(delegationApprovalSummarySchema.safeParse(summary).success).toBe(true);
        expect(delegationApprovalSummarySchema.safeParse(approval).success).toBe(false);
    });

    it('names every coverage reason a refusal can carry', () => {
        expect(approvalCoverageReasonSchema.options).toContain('covered');
        expect(approvalCoverageReasonSchema.options).toContain('accept_not_offered');
        expect(APPROVAL_ESCALATION_GRACE_MS).toBe(90_000);
    });
});

describe('agent.delegation.approval event', () => {
    const payload = { sessionId: 's', delegationId: 'd', requestId: 'r', state: 'pending' };

    it('carries identifiers and a closed state only, and is transient', () => {
        expect(delegationApprovalChangedSchema.safeParse(payload).success).toBe(true);
        expect(
            delegationApprovalChangedSchema.safeParse({ ...payload, command: 'ls' }).success,
        ).toBe(false);
        expect(
            delegationApprovalChangedSchema.safeParse({ ...payload, state: 'open' }).success,
        ).toBe(false);
        expect(
            isTransientServerEvent({ event: 'agent.delegation.approval', payload } as never),
        ).toBe(true);
    });
});

describe('agents.delegation approval setting', () => {
    it('defaults to on', () => {
        expect(agentDelegationSettingsSchema.parse({}).approval).toBe(true);
        expect(agentDelegationSettingsSchema.parse({ approval: false }).approval).toBe(false);
    });
});
