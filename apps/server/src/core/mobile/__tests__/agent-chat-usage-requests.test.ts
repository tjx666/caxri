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

describe('mobile Agent Chat usage notice dismissal', () => {
    const dismiss = (
        domain: ReturnType<typeof domainFixture>,
        forward: (operation: unknown) => Promise<unknown>,
        notice: 'planPace' | 'credits' = 'planPace',
    ) =>
        invoke(
            {
                method: 'mobile.agentChat.dismissUsageNotice',
                params: { terminalId: 'terminal-1', notice },
            },
            domain,
            forward,
        );

    it.each(['planPace', 'credits'] as const)(
        "keeps the %s dismissal for the Chat's provider on the Server",
        async (notice) => {
            const forward = vi.fn(() => Promise.resolve(null));
            const domain = domainFixture({ surface: 'chat', provider: 'claude' });
            expect(await dismiss(domain, forward, notice)).toBeNull();
            expect(forward).toHaveBeenCalledWith({
                method: 'usage.dismissNotice',
                params: { provider: 'claude', notice },
            });
        },
    );

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
                isMobileGatewayMethodAllowedForRole(role, 'mobile.agentChat.dismissUsageNotice'),
            ).toBe(true);
    });
});

describe('mobile Agent Chat usage-limit and usage guard actions', () => {
    const actions = [
        {
            request: {
                method: 'mobile.agentChat.usageLimitWait',
                params: { terminalId: 'terminal-1', turnId: 'turn-1', action: 'continueNow' },
            },
            forwarded: {
                method: 'agentChat.usageLimitWait',
                params: { terminalId: 'terminal-1', turnId: 'turn-1', action: 'continueNow' },
            },
        },
        {
            request: {
                method: 'mobile.agentChat.usageLimitWait',
                params: { terminalId: 'terminal-1', turnId: 'turn-1', action: 'cancel' },
            },
            forwarded: {
                method: 'agentChat.usageLimitWait',
                params: { terminalId: 'terminal-1', turnId: 'turn-1', action: 'cancel' },
            },
        },
        {
            request: {
                method: 'mobile.agentChat.generateHandoff',
                params: { terminalId: 'terminal-1' },
            },
            forwarded: {
                method: 'agentChat.generateHandoff',
                params: { terminalId: 'terminal-1' },
            },
        },
        {
            request: {
                method: 'mobile.agentChat.bypassUsageGuard',
                params: { terminalId: 'terminal-1' },
            },
            forwarded: {
                method: 'agentChat.bypassUsageGuard',
                params: { terminalId: 'terminal-1' },
            },
        },
    ] as const;

    it.each(actions)("forwards $request.method to Core's own Chat method", async (action) => {
        const forward = vi.fn(() => Promise.resolve(null));
        const domain = domainFixture({ surface: 'chat' });
        expect(await invoke(action.request, domain, forward)).toBeNull();
        expect(forward).toHaveBeenCalledWith(action.forwarded);
    });

    it.each(actions)('refuses $request.method on a PTY without forwarding', async (action) => {
        const forward = vi.fn(() => Promise.resolve(null));
        await expect(invoke(action.request, domainFixture({}), forward)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(forward).not.toHaveBeenCalled();
    });

    it('carries the sending grant: reply and control, never view', () => {
        for (const { request } of actions) {
            expect(isMobileAgentChatRead(request)).toBe(false);
            expect(isMobileGatewayMethodAllowedForRole('view', request.method)).toBe(false);
            for (const role of ['reply', 'control'] as const)
                expect(isMobileGatewayMethodAllowedForRole(role, request.method)).toBe(true);
        }
    });
});
