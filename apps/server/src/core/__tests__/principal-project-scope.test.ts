import type { CommandExecutionContext } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { assertOwnerOnlyMethod } from '../principal-project-scope';

const contextFor = (kind: string): CommandExecutionContext =>
    ({ principal: { kind, projectIds: [] } }) as unknown as CommandExecutionContext;

describe('assertOwnerOnlyMethod', () => {
    it('refuses spec-declared owner-only methods for Agent principals', () => {
        for (const method of [
            'bot.session.handOver',
            'bot.session.takeBack',
            'bot.conversations',
            'bot.managedSessions',
            'session.permissionAutoAllowStatus',
            // The Delegated Sessions feed reads other Sessions' results; an Agent grant must not.
            'agent.delegation.sessions',
            'agent.delegation.statuses',
            'agent.delegation.retryOptions',
            'agent.delegation.retry',
            'agent.delegation.cancelScheduledRetry',
            // The user answers a delegated Session's question; its text must not reach an Agent grant.
            'agent.delegation.questionAnswer',
            'agent.delegation.questionDetail',
        ])
            for (const kind of ['agent', 'delegation-client'])
                expect(() => assertOwnerOnlyMethod(contextFor(kind), method)).toThrow(/owner/);
    });

    it('allows the owner clients and unrestricted methods', () => {
        expect(() =>
            assertOwnerOnlyMethod(contextFor('desktop'), 'bot.session.handOver'),
        ).not.toThrow();
        expect(() =>
            assertOwnerOnlyMethod(contextFor('human-cli'), 'bot.conversations'),
        ).not.toThrow();
        expect(() => assertOwnerOnlyMethod(contextFor('agent'), 'agent.list')).not.toThrow();
    });
});
