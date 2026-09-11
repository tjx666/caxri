import { describe, expect, it } from 'vitest';

import type { StoredAgentDelegation } from '../../db';
import { applyDelegationLifecycle } from '../lifecycle';

const record: StoredAgentDelegation = {
    receipt: {
        delegationId: 'task',
        projectId: 'project',
        sessionId: 'session',
        terminalId: 'terminal',
        provider: 'claude',
        status: 'running',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
    },
    principal: { kind: 'human-cli', id: 'owner' },
    input: {
        projectId: 'project',
        sessionId: 'session',
        provider: 'claude',
        prompt: 'Synthetic task',
    },
    fingerprint: 'fingerprint',
    frozenLaunch: { executable: 'claude', args: [] },
    promptDigest: 'a'.repeat(64),
    launchId: 'launch',
    providerSessionId: 'native',
    turnId: 'first',
};
const signal = {
    terminalId: 'terminal',
    launchId: 'launch',
    provider: 'claude' as const,
    agentSessionId: 'native',
};

describe('Delegation continuation correlation', () => {
    it('requires coordinator evidence to bind a new native turn, then rejects the older Stop', () => {
        const continued = applyDelegationLifecycle(record, {
            ...signal,
            phase: 'turnStarted',
            agentTurnId: 'second',
            agentContinuedTurnId: 'first',
            agentPromptDigest: 'b'.repeat(64),
        })!;
        expect(continued).toMatchObject({
            turnId: 'second',
            continuationPromptDigests: ['b'.repeat(64)],
            receipt: { status: 'running' },
        });
        expect(
            applyDelegationLifecycle(continued, {
                ...signal,
                phase: 'turnFinished',
                agentTurnId: 'first',
                agentResponseDigest: 'c'.repeat(64),
            }),
        ).toBeUndefined();
        expect(
            applyDelegationLifecycle(continued, {
                ...signal,
                phase: 'turnFinished',
                agentTurnId: 'second',
                agentResponseDigest: 'c'.repeat(64),
            })?.receipt.status,
        ).toBe('collecting');
        expect(
            applyDelegationLifecycle(record, {
                ...signal,
                phase: 'turnStarted',
                agentTurnId: 'second',
                agentPromptDigest: 'b'.repeat(64),
            })?.receipt,
        ).toMatchObject({ status: 'answer_unavailable', failure: 'correlation_missing' });
        expect(
            applyDelegationLifecycle(
                { ...record, receipt: { ...record.receipt, status: 'human_intervened' } },
                {
                    ...signal,
                    phase: 'turnStarted',
                    agentTurnId: 'second',
                    agentContinuedTurnId: 'first',
                    agentPromptDigest: 'b'.repeat(64),
                },
            ),
        ).toBeUndefined();
    });
});
