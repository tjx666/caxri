import type { AgentUsageReadout } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

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

describe('mobile Agent Chat plan limits', () => {
    it("returns the Chat's plan limits without its tokens or cost", async () => {
        const domain = domainFixture({
            surface: 'chat',
            usage: {
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
            },
        });
        expect(await readUsage(domain)).toEqual(limit);
    });

    it('answers null before the provider reported a limit, and refuses a PTY', async () => {
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
