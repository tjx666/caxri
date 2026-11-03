import { describe, expect, it } from 'vitest';

import { agentDelegationCreateRequestSchema } from '../delegation/agent-delegation-contract';

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
