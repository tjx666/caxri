import { describe, expect, it } from 'vitest';

import type { StoredAgentDelegation } from '../../db';
import { applyDelegationLifecycle, isReceiptTransition } from '../lifecycle';

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
    it('retains exact Grok Stop evidence without claiming native completion', () => {
        const grok: StoredAgentDelegation = {
            ...record,
            receipt: { ...record.receipt, provider: 'grok' },
        };
        const stop = {
            ...signal,
            provider: 'grok' as const,
            phase: 'turnFinished' as const,
            agentTurnId: 'first',
            agentResponseDigest: 'c'.repeat(64),
            agentResponseByteLength: 12,
        };
        const stopped = applyDelegationLifecycle(grok, stop, 'evidence');
        expect(stopped).toMatchObject({
            receipt: { status: 'running' },
            responseDigest: 'c'.repeat(64),
            responseByteLength: 12,
            responseStopCount: 1,
        });
        expect(applyDelegationLifecycle(stopped!, stop)).toBeUndefined();
        expect(applyDelegationLifecycle(stopped!, stop, 'evidence')?.responseStopCount).toBe(2);
        expect(
            applyDelegationLifecycle(stopped!, { ...stop, agentId: 'child' }, 'evidence'),
        ).toBeUndefined();
        expect(
            applyDelegationLifecycle(
                stopped!,
                {
                    ...signal,
                    provider: 'grok',
                    phase: 'turnFinished',
                    agentTurnId: undefined,
                },
                'evidence',
            ),
        ).toBeUndefined();
    });
    it('settles exact Grok failures while ignoring native child failures', () => {
        const grok = { ...record, receipt: { ...record.receipt, provider: 'grok' as const } };
        const failure = {
            ...signal,
            provider: 'grok' as const,
            phase: 'turnFailed' as const,
            agentTurnId: 'first',
            agentFailure: 'rate_limit' as const,
        };
        expect(applyDelegationLifecycle(grok, failure)?.receipt).toMatchObject({
            status: 'failed',
            failure: 'rate_limited',
        });
        expect(applyDelegationLifecycle(grok, { ...failure, agentId: 'child' })).toBeUndefined();
    });
    it.each([
        [undefined, 'new-turn', 'prompt_digest_missing'],
        ['b'.repeat(64), 'new-turn', 'prompt_digest_mismatch'],
        [record.promptDigest, undefined, 'turn_missing'],
    ])(
        'reports a closed reason for first-turn correlation failure (%#)',
        (agentPromptDigest, agentTurnId, correlationFailure) => {
            expect(
                applyDelegationLifecycle(
                    { ...record, turnId: undefined },
                    { ...signal, phase: 'turnStarted', agentPromptDigest, agentTurnId },
                )?.receipt,
            ).toMatchObject({ failure: 'correlation_missing', correlationFailure });
        },
    );
    it('fails closed when a first Codex turn has no native session identity', () => {
        const codex: StoredAgentDelegation = {
            ...record,
            providerSessionId: undefined,
            turnId: undefined,
            input: { ...record.input, provider: 'codex' },
            receipt: { ...record.receipt, provider: 'codex', status: 'awaiting_ready' },
        };
        expect(
            applyDelegationLifecycle(codex, {
                ...signal,
                provider: 'codex',
                agentSessionId: undefined,
                phase: 'turnStarted',
                agentTurnId: 'owned-turn',
                agentPromptDigest: record.promptDigest,
            })?.receipt,
        ).toMatchObject({ status: 'answer_unavailable', failure: 'correlation_missing' });
    });
    it.each(['sessionIdentified', 'turnStarted'] as const)(
        'binds Codex identity from the first owned %s signal',
        (phase) => {
            const codex: StoredAgentDelegation = {
                ...record,
                providerSessionId: undefined,
                turnId: undefined,
                input: { ...record.input, provider: 'codex' },
                receipt: { ...record.receipt, provider: 'codex', status: 'awaiting_ready' },
            };
            const first = {
                ...signal,
                provider: 'codex' as const,
                phase,
                agentTurnId: 'owned-turn',
                agentPromptDigest: record.promptDigest,
            };
            expect(
                applyDelegationLifecycle(codex, { ...first, launchId: 'foreign-launch' }),
            ).toBeUndefined();
            const bound = applyDelegationLifecycle(codex, first)!;
            expect(bound.providerSessionId).toBe('native');
            expect(
                applyDelegationLifecycle(bound, { ...first, agentSessionId: 'foreign-session' })
                    ?.receipt,
            ).toMatchObject({ status: 'interrupted', failure: 'session_changed' });
            const running =
                phase === 'turnStarted'
                    ? bound
                    : applyDelegationLifecycle(bound, { ...first, phase: 'turnStarted' })!;
            expect(running.receipt.status).toBe('running');
            expect(
                applyDelegationLifecycle(running, {
                    ...first,
                    phase: 'turnFinished',
                    agentResponseDigest: 'c'.repeat(64),
                }),
            ).toBeUndefined();
        },
    );
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

    it('returns a Codex task past its startup deadline to awaiting its turn once the native session starts', () => {
        const waiting: StoredAgentDelegation = {
            ...record,
            receipt: {
                ...record.receipt,
                provider: 'codex',
                status: 'blocked',
                failure: 'startup_waiting',
            },
            providerSessionId: undefined,
            turnId: undefined,
        };

        const started = applyDelegationLifecycle(waiting, {
            ...signal,
            provider: 'codex',
            phase: 'sessionIdentified',
        });

        expect(started).toMatchObject({
            providerSessionId: 'native',
            receipt: { status: 'awaiting_ready' },
        });
        expect(started?.receipt.failure).toBeUndefined();
    });
});

describe('Delegation receipt transitions', () => {
    it('announces a new task and status or failure changes, but not a revision-only save', () => {
        const { receipt } = record;
        expect(isReceiptTransition(undefined, receipt)).toBe(true);
        expect(isReceiptTransition(receipt, { ...receipt, status: 'completed' })).toBe(true);
        const interrupted = {
            ...receipt,
            status: 'interrupted' as const,
            failure: 'caller_stopped' as const,
        };
        expect(
            isReceiptTransition(interrupted, { ...interrupted, failure: 'target_changed' }),
        ).toBe(true);
        expect(isReceiptTransition(receipt, { ...receipt, revision: 2, updatedAt: 2 })).toBe(false);
    });
});
