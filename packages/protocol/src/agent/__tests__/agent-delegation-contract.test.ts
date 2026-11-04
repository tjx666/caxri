import { describe, expect, it } from 'vitest';

import {
    agentDelegationCreateRequestSchema,
    formatDelegationRetryNotice,
    isRetryableDelegationFailure,
} from '../delegation/agent-delegation-contract';
import { agentDelegationSessionsMethods } from '../delegation/agent-delegation-sessions';
import { agentDelegationFailureSchema } from '../delegation/agent-delegation-settings';

const request = { projectId: 'project-1', provider: 'claude', prompt: 'Review the design' };
const newSession = { ...request, newSession: true, title: 'Review the retry design' };

describe('agentDelegationCreateRequestSchema consult', () => {
    it('accepts a consult only for a new Session', () => {
        expect(
            agentDelegationCreateRequestSchema.safeParse({ ...newSession, consult: true }).success,
        ).toBe(true);
        expect(
            agentDelegationCreateRequestSchema.safeParse({
                ...request,
                sessionId: 'session-1',
                consult: true,
            }).success,
        ).toBe(false);
    });

    it('refuses a request that is both a consult and a hand-off', () => {
        const parsed = agentDelegationCreateRequestSchema.safeParse({
            ...newSession,
            consult: true,
            handoff: true,
        });

        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.map(({ message }) => message)).toContain(
            'A consult is not a hand-off; choose one',
        );
    });

    it('accepts only the literal true', () => {
        expect(
            agentDelegationCreateRequestSchema.safeParse({ ...newSession, consult: false }).success,
        ).toBe(false);
    });
});

describe('agentDelegationCreateRequestSchema surface', () => {
    it.each(['chat', 'pty'])('accepts a forced %s surface for a new task', (surface) => {
        expect(agentDelegationCreateRequestSchema.parse({ ...newSession, surface }).surface).toBe(
            surface,
        );
        expect(
            agentDelegationCreateRequestSchema.safeParse({
                ...request,
                sessionId: 'session-1',
                surface,
            }).success,
        ).toBe(true);
    });

    it('refuses an unknown surface', () => {
        expect(
            agentDelegationCreateRequestSchema.safeParse({ ...newSession, surface: 'terminal' })
                .success,
        ).toBe(false);
    });

    it.each([{ followUpOf: 'task-1' }, { resumeFrom: 'task-1' }])(
        'refuses a surface together with a continuation %j',
        (continuation) => {
            const parsed = agentDelegationCreateRequestSchema.safeParse({
                projectId: 'project-1',
                sessionId: 'session-1',
                prompt: 'Review the design',
                surface: 'chat',
                ...continuation,
            });
            expect(parsed.success).toBe(false);
            expect(parsed.error?.issues.map(({ message }) => message)).toContain(
                'A surface applies to a new task, not a continuation',
            );
        },
    );

    it('refuses a surface together with a hand-over', () => {
        expect(
            agentDelegationCreateRequestSchema.safeParse({
                projectId: 'project-1',
                sessionId: 'session-1',
                prompt: 'Review the design',
                surface: 'pty',
                continueFromHandover: 'handover-1',
            }).success,
        ).toBe(false);
    });
});

describe('isRetryableDelegationFailure', () => {
    const retryable = new Set([
        'rate_limited',
        'authentication_failed',
        'output_limit',
        'startup_not_ready',
        'provider_failed',
        'launch_failed',
        'hooks_required',
        'quota_exhausted',
    ]);

    it.each(agentDelegationFailureSchema.options)('classifies the failure %s', (failure) => {
        expect(isRetryableDelegationFailure({ status: 'failed', failure })).toBe(
            retryable.has(failure),
        );
    });

    it('accepts only a failed status with a failure', () => {
        expect(isRetryableDelegationFailure({ status: 'failed' })).toBe(false);
        expect(
            isRetryableDelegationFailure({ status: 'interrupted', failure: 'rate_limited' }),
        ).toBe(false);
        expect(isRetryableDelegationFailure({ status: 'running', failure: 'rate_limited' })).toBe(
            false,
        );
    });
});

describe('delegated task retry', () => {
    it('words the notice with both task IDs', () => {
        expect(formatDelegationRetryNotice('old-id', 'new-id')).toBe(
            'Delegated task old-id was retried as new-id. Wait on new-id for the result.',
        );
    });

    it('takes a provider only with mode fresh and without a schedule', () => {
        const { params } = agentDelegationSessionsMethods['agent.delegation.retry'];

        expect(params.safeParse({ delegationId: 'task-1', mode: 'resume' }).success).toBe(true);
        expect(params.safeParse({ delegationId: 'task-1', mode: 'fresh' }).success).toBe(true);
        expect(
            params.safeParse({ delegationId: 'task-1', mode: 'fresh', provider: 'codex' }).success,
        ).toBe(true);
        expect(
            params.safeParse({ delegationId: 'task-1', mode: 'resume', provider: 'codex' }).success,
        ).toBe(false);
        expect(
            params.safeParse({
                delegationId: 'task-1',
                mode: 'fresh',
                scheduleAt: 'reset',
                provider: 'codex',
            }).success,
        ).toBe(false);
        expect(
            params.safeParse({ delegationId: 'task-1', mode: 'fresh', provider: 'other' }).success,
        ).toBe(false);
        expect(
            params.safeParse({ delegationId: 'task-1', mode: 'fresh', model: 'x' }).success,
        ).toBe(false);
        expect(params.safeParse({ delegationId: 'task-1', mode: 'other' }).success).toBe(false);
    });

    it('keeps both retry methods owner-only', () => {
        for (const name of ['agent.delegation.retryOptions', 'agent.delegation.retry'] as const)
            expect(agentDelegationSessionsMethods[name]).toMatchObject({
                principal: 'owner',
            });
    });
});
