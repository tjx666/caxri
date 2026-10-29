// oxlint-disable typescript/require-await -- Async domain fakes preserve the production Promise boundary.
import type { Principal } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../domain-service';
import { switchMobileTerminalSurface, terminalForPrincipal } from '../action-requests';

const principal: Extract<Principal, { kind: 'paired-device' }> = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'control',
    projectIds: ['project-a'],
};

/**
 * Mimics the introspection selector: the visible Terminal's title equals the id of a Terminal in an unauthorized
 * Project, so a title fallback would resolve the request to the visible record.
 */
const domainFixture = () => {
    const request = vi.fn(
        async (
            method: string,
            parameters?: { query?: { selector?: string } },
        ): Promise<unknown> => {
            if (method !== 'terminal.queryForPrincipal') throw new Error(`Unexpected ${method}`);
            const visible = { id: 'terminal-a', title: 'terminal-b', sessionId: 'session-a' };
            const selector = parameters?.query?.selector;
            const matches = selector === visible.id || selector === visible.title ? [visible] : [];
            return { terminals: matches };
        },
    );
    const requestWithSignal = vi.fn(async () => ({ status: 'switched' }));
    return {
        domainService: { request, requestWithSignal } as unknown as ServerDomainService,
        requestWithSignal,
    };
};

describe('mobile terminal authorization', () => {
    it('accepts the exact id of a visible Terminal', async () => {
        const { domainService } = domainFixture();
        await expect(
            terminalForPrincipal(domainService, principal, 'terminal-a'),
        ).resolves.toMatchObject({
            id: 'terminal-a',
        });
    });

    it('rejects an id that only matches a visible Terminal title and forwards nothing', async () => {
        const { domainService, requestWithSignal } = domainFixture();
        await expect(
            terminalForPrincipal(domainService, principal, 'terminal-b'),
        ).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
        await expect(
            switchMobileTerminalSurface(
                domainService,
                principal,
                {
                    method: 'mobile.terminal.switchSurface',
                    params: { terminalId: 'terminal-b', surface: 'chat', interruptTurn: false },
                } as never,
                new AbortController().signal,
            ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(requestWithSignal).not.toHaveBeenCalled();
    });
});
