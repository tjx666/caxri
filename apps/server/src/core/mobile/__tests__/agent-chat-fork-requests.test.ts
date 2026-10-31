// oxlint-disable typescript/require-await -- Async domain fakes preserve the production Promise boundary.
import { describe, expect, it, vi } from 'vitest';

import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import { domainFixture, invoke } from './agent-chat-requests.fixture';

describe('mobile Agent Chat Fork and Continue in Another Agent', () => {
    it('forks the whole conversation through Core and returns the new Session', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<unknown>>(async () => ({
            sessionId: 'session-2',
            terminalId: 'terminal-2',
        }));
        await expect(
            invoke(
                { method: 'mobile.agentChat.fork', params: { terminalId: 'terminal-1' } },
                domainFixture({ surface: 'chat' }),
                forward,
            ),
        ).resolves.toEqual({ sessionId: 'session-2', terminalId: 'terminal-2' });
        expect(forward).toHaveBeenCalledWith({
            method: 'agentChat.fork',
            params: { terminalId: 'terminal-1' },
        });
    });

    it("continues as the menu's manual continuation and drops the delegation id", async () => {
        const forward = vi.fn<(operation: unknown) => Promise<unknown>>(async () => ({
            sessionId: 'session-3',
            delegationId: 'delegation-1',
        }));
        await expect(
            invoke(
                {
                    method: 'mobile.agentChat.continueInAgent',
                    params: { terminalId: 'terminal-1', provider: 'claude' },
                },
                domainFixture({ surface: 'chat' }),
                forward,
            ),
        ).resolves.toEqual({ sessionId: 'session-3' });
        expect(forward).toHaveBeenCalledWith({
            method: 'agentChat.continueInAgent',
            params: { terminalId: 'terminal-1', provider: 'claude', manual: true },
        });
    });

    it("continues a usage-limit card's failed turn, or the usage guard's window, as Desktop's same control does", async () => {
        const forward = vi.fn<(operation: unknown) => Promise<unknown>>(async () => ({
            sessionId: 'session-3',
            delegationId: 'delegation-1',
        }));
        for (const origin of [
            { kind: 'usageLimit', turnId: 'turn-7' },
            { kind: 'usageGuard' },
        ] as const)
            // eslint-disable-next-line no-await-in-loop -- The forwarded calls are asserted in request order.
            await invoke(
                {
                    method: 'mobile.agentChat.continueInAgent',
                    params: { terminalId: 'terminal-1', provider: 'claude', origin },
                },
                domainFixture({ surface: 'chat' }),
                forward,
            );
        expect(forward.mock.calls.map(([operation]) => operation)).toEqual([
            {
                method: 'agentChat.continueInAgent',
                params: { terminalId: 'terminal-1', provider: 'claude', turnId: 'turn-7' },
            },
            {
                method: 'agentChat.continueInAgent',
                params: { terminalId: 'terminal-1', provider: 'claude' },
            },
        ]);
    });

    it('lists the continuation targets Core reports', async () => {
        const targets = [
            { provider: 'codex' as const, unavailable: 'current' as const },
            { provider: 'claude' as const },
        ];
        await expect(
            invoke(
                {
                    method: 'mobile.agentChat.continuationTargets',
                    params: { terminalId: 'terminal-1' },
                },
                domainFixture({ surface: 'chat', targets }),
            ),
        ).resolves.toEqual({ targets });
    });

    it('refuses a Terminal that is not a Chat, or one outside the grant, before forwarding', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<unknown>>(async () => null);
        const fork = {
            method: 'mobile.agentChat.fork',
            params: { terminalId: 'terminal-1' },
        } as const;
        await expect(invoke(fork, domainFixture({}), forward)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        await expect(
            invoke(fork, domainFixture({ surface: 'chat', terminals: 0 }), forward),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(forward).not.toHaveBeenCalled();
    });

    it('grants Fork and Continue in Another Agent only to control devices', () => {
        for (const method of [
            'mobile.agentChat.fork',
            'mobile.agentChat.continuationTargets',
            'mobile.agentChat.continueInAgent',
        ])
            expect(
                (['view', 'reply', 'control'] as const).map((role) =>
                    isMobileGatewayMethodAllowedForRole(role, method),
                ),
            ).toEqual([false, false, true]);
    });
});
