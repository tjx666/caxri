// oxlint-disable typescript/require-await -- Async domain fakes preserve the production Promise boundary.
import { describe, expect, it, vi } from 'vitest';

import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import { domainFixture, invoke } from './agent-chat-requests.fixture';

const command = { id: 'request-1', kind: 'command', command: 'bun install' } as const;

describe('mobile Agent Chat pending requests', () => {
    it('lists the requests a Chat waits on without reading the Chat', async () => {
        const domain = domainFixture({
            surface: 'chat',
            waiting: [
                {
                    kind: 'chat',
                    sessionId: 'session-1',
                    terminalId: 'terminal-2',
                    requests: [command],
                },
                {
                    kind: 'chat',
                    sessionId: 'session-1',
                    terminalId: 'terminal-1',
                    requests: [command],
                },
            ],
        });
        const result = await invoke(
            { method: 'mobile.agentChat.requests', params: { terminalId: 'terminal-1' } },
            domain,
        );
        expect(result).toEqual({ requests: [command] });
        // `agentChat.read` would start the provider of an idle Chat.
        expect(domain.request).not.toHaveBeenCalledWith('agentChat.read', expect.anything());
    });

    it('answers an empty list when the Chat is not waiting', async () => {
        const result = await invoke(
            { method: 'mobile.agentChat.requests', params: { terminalId: 'terminal-1' } },
            domainFixture({ surface: 'chat', waiting: [] }),
        );
        expect(result).toEqual({ requests: [] });
    });

    it('refuses a PTY Terminal and a Terminal outside the grant', async () => {
        const request = {
            method: 'mobile.agentChat.requests',
            params: { terminalId: 'terminal-1' },
        } as const;
        await expect(invoke(request, domainFixture({}))).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        await expect(
            invoke(request, domainFixture({ surface: 'chat', terminals: 0 })),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lets every role read the list while only control may answer', () => {
        for (const role of ['view', 'reply', 'control'] as const)
            expect(isMobileGatewayMethodAllowedForRole(role, 'mobile.agentChat.requests')).toBe(
                true,
            );
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.agentChat.respond')).toBe(
            false,
        );
        expect(vi.isMockFunction(domainFixture({}).request)).toBe(true);
    });
});
