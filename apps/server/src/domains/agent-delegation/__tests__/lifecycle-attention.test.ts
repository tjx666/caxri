import { describe, expect, it } from 'vitest';

import { AgentAttentionTracker } from '../../agents/attention-tracker';
import type { AgentLifecycleSignal } from '../../agents/index';
import type { StoredAgentDelegation } from '../../db';
import { applyDelegationLifecycle } from '../lifecycle';

const running: StoredAgentDelegation = {
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
    turnId: 'turn',
};
const blocked: StoredAgentDelegation = {
    ...running,
    receipt: { ...running.receipt, status: 'blocked', failure: 'permission_required' },
};
const signal = {
    terminalId: 'terminal',
    launchId: 'launch',
    provider: 'claude' as const,
    agentSessionId: 'native',
};

describe('Delegation blocked on a permission request', () => {
    it('blocks the task for the turn that asked and runs again once the request is answered', () => {
        const asked = applyDelegationLifecycle(running, {
            ...signal,
            phase: 'attentionRequested',
            agentTurnId: 'turn',
        });
        expect(asked?.receipt).toMatchObject({
            status: 'blocked',
            failure: 'permission_required',
        });

        const answered = applyDelegationLifecycle(asked!, {
            ...signal,
            phase: 'attentionResolved',
            agentTurnId: 'turn',
        });
        expect(answered?.receipt.status).toBe('running');
        expect(answered?.receipt.failure).toBeUndefined();
    });

    it('runs again on a resolution that names no turn, as every Chat provider reports it', () => {
        const answered = applyDelegationLifecycle(blocked, {
            ...signal,
            phase: 'attentionResolved',
        });

        expect(answered?.receipt.status).toBe('running');
        expect(answered?.receipt.failure).toBeUndefined();
        expect(answered?.turnId).toBe('turn');
    });

    it('ignores a resolution of another turn', () => {
        expect(
            applyDelegationLifecycle(blocked, {
                ...signal,
                phase: 'attentionResolved',
                agentTurnId: 'earlier',
            }),
        ).toBeUndefined();
    });

    it('leaves a task that is not waiting on a permission request alone', () => {
        expect(
            applyDelegationLifecycle(running, {
                ...signal,
                phase: 'attentionResolved',
                agentTurnId: 'turn',
            }),
        ).toBeUndefined();
        const startupWaiting: StoredAgentDelegation = {
            ...running,
            receipt: { ...running.receipt, status: 'blocked', failure: 'startup_waiting' },
        };
        expect(
            applyDelegationLifecycle(startupWaiting, {
                ...signal,
                phase: 'attentionResolved',
                agentTurnId: 'turn',
            }),
        ).toBeUndefined();
    });

    it('keeps ignoring a request of a turn the task does not own', () => {
        expect(
            applyDelegationLifecycle(running, {
                ...signal,
                phase: 'attentionRequested',
                agentTurnId: 'other',
            }),
        ).toBeUndefined();
    });
});

describe('Delegation blocked on a Claude Code permission prompt', () => {
    /**
     * Claude Code's hooks report the end of a permission prompt as PostToolBatch (`toolBatchFinished`), never as
     * `attentionResolved`, and PostToolBatch carries no `prompt_id`. The coordinator only forwards the phase when the
     * attention tracker says it resolved the final pending request, so the tests deliver signals through the real
     * tracker the way `AgentCoordinator` does.
     */
    function deliver(
        attention: AgentAttentionTracker,
        record: StoredAgentDelegation,
        next: Partial<AgentLifecycleSignal> & Pick<AgentLifecycleSignal, 'phase'>,
    ): StoredAgentDelegation | undefined {
        const delivered: AgentLifecycleSignal = { ...signal, ...next };
        if (delivered.phase === 'attentionRequested') attention.request(delivered);
        return attention.allowsLifecycle(delivered)
            ? applyDelegationLifecycle(record, delivered)
            : undefined;
    }

    it('blocks on the permission request and runs again when the tool batch finishes', () => {
        const attention = new AgentAttentionTracker();
        const asked = deliver(attention, running, {
            phase: 'attentionRequested',
            agentTurnId: 'turn',
        });
        expect(asked?.receipt).toMatchObject({ status: 'blocked', failure: 'permission_required' });

        const answered = deliver(attention, asked!, { phase: 'toolBatchFinished' });

        expect(answered?.receipt.status).toBe('running');
        expect(answered?.receipt.failure).toBeUndefined();
        expect(answered?.turnId).toBe('turn');
    });

    it('runs again when the finished tool batch names the task turn', () => {
        const answered = applyDelegationLifecycle(blocked, {
            ...signal,
            phase: 'toolBatchFinished',
            agentTurnId: 'turn',
        });

        expect(answered?.receipt.status).toBe('running');
        expect(answered?.receipt.failure).toBeUndefined();
    });

    it('waits for the last of two concurrent permission requests', () => {
        const attention = new AgentAttentionTracker();
        const asked = deliver(attention, running, {
            phase: 'attentionRequested',
            agentTurnId: 'turn',
        });
        attention.request({
            ...signal,
            phase: 'attentionRequested',
            agentId: 'subagent',
        });

        expect(deliver(attention, asked!, { phase: 'toolBatchFinished' })).toBeUndefined();
    });

    it('ignores a tool batch of another turn', () => {
        expect(
            applyDelegationLifecycle(blocked, {
                ...signal,
                phase: 'toolBatchFinished',
                agentTurnId: 'earlier',
            }),
        ).toBeUndefined();
    });

    it('ignores a tool batch finished by a subagent', () => {
        expect(
            applyDelegationLifecycle(blocked, {
                ...signal,
                phase: 'toolBatchFinished',
                agentId: 'subagent',
            }),
        ).toBeUndefined();
    });

    it('ignores a tool batch when no request preceded it, as the tracker withholds it', () => {
        const attention = new AgentAttentionTracker();

        expect(deliver(attention, running, { phase: 'toolBatchFinished' })).toBeUndefined();
        expect(deliver(attention, blocked, { phase: 'toolBatchFinished' })).toBeUndefined();
    });

    it('leaves a task that is not waiting on a permission request alone', () => {
        expect(
            applyDelegationLifecycle(running, { ...signal, phase: 'toolBatchFinished' }),
        ).toBeUndefined();
        const startupWaiting: StoredAgentDelegation = {
            ...running,
            receipt: { ...running.receipt, status: 'blocked', failure: 'startup_waiting' },
        };
        expect(
            applyDelegationLifecycle(startupWaiting, { ...signal, phase: 'toolBatchFinished' }),
        ).toBeUndefined();
    });

    it('stays blocked on a task whose turn has not started', () => {
        const withoutTurn: StoredAgentDelegation = { ...blocked, turnId: undefined };

        expect(
            applyDelegationLifecycle(withoutTurn, { ...signal, phase: 'toolBatchFinished' }),
        ).toBeUndefined();
    });
});
