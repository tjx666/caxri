import type { AgentUsageReadout } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { isMobileAgentChatRead } from '../agent-chat-requests';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import { domainFixture, invoke } from './agent-chat-requests.fixture';

const limit = {
    provider: 'claude',
    observedAt: 1,
    planType: 'max',
    windows: [{ windowMinutes: 300, usedPercent: 38, resetsAt: 2 }],
} satisfies AgentUsageReadout['limit'];

const readUsage = (domain: ReturnType<typeof domainFixture>) =>
    invoke({ method: 'mobile.agentChat.readUsage', params: { terminalId: 'terminal-1' } }, domain);

describe('mobile Agent Chat usage', () => {
    it("returns the conversation's tokens, cost, and the provider's plan limits", async () => {
        const usage = {
            provider: 'claude',
            tokens: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                reasoning: 0,
                total: 2,
            },
            costUsd: 0.01,
            models: [],
            unpricedModels: [],
            limit,
        } satisfies AgentUsageReadout;
        expect(await readUsage(domainFixture({ surface: 'chat', usage }))).toEqual(usage);
    });

    it('answers null before the conversation recorded usage, and refuses a PTY', async () => {
        expect(await readUsage(domainFixture({ surface: 'chat' }))).toBeNull();
        await expect(readUsage(domainFixture({}))).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('is a read every paired role may call', () => {
        expect(
            isMobileAgentChatRead({
                method: 'mobile.agentChat.readUsage',
                params: { terminalId: 'terminal-1' },
            }),
        ).toBe(true);
        for (const role of ['view', 'reply', 'control'] as const)
            expect(isMobileGatewayMethodAllowedForRole(role, 'mobile.agentChat.readUsage')).toBe(
                true,
            );
    });
});

describe('mobile Agent Chat pace reminder dismissal', () => {
    const dismiss = (
        domain: ReturnType<typeof domainFixture>,
        forward: (operation: unknown) => Promise<unknown>,
    ) =>
        invoke(
            { method: 'mobile.agentChat.dismissPlanPace', params: { terminalId: 'terminal-1' } },
            domain,
            forward,
        );

    it("asks the Server to keep the dismissal for the Chat's provider", async () => {
        const forward = vi.fn(() => Promise.resolve(null));
        expect(
            await dismiss(domainFixture({ surface: 'chat', provider: 'claude' }), forward),
        ).toBeNull();
        expect(forward).toHaveBeenCalledWith({
            method: 'usage.dismissNotice',
            params: { provider: 'claude', notice: 'planPace' },
        });
    });

    it('refuses a PTY and a Chat with no provider yet, without forwarding', async () => {
        const forward = vi.fn(() => Promise.resolve(null));
        await expect(dismiss(domainFixture({ provider: 'claude' }), forward)).rejects.toMatchObject(
            {
                code: 'CONFLICT',
            },
        );
        await expect(dismiss(domainFixture({ surface: 'chat' }), forward)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(forward).not.toHaveBeenCalled();
    });

    it('is open to every paired role that may read the limit', () => {
        for (const role of ['view', 'reply', 'control'] as const)
            expect(
                isMobileGatewayMethodAllowedForRole(role, 'mobile.agentChat.dismissPlanPace'),
            ).toBe(true);
    });
});
